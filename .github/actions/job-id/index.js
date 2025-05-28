// RUNNER_TEMP=/home/runner/work/_temp
// runner process: /home/runner/actions-runner/cached/bin/Runner.Worker
// runner dir: /home/runner/actions-runner/cached/_diag
// Worker_*.log
// line: "INFO JobRunner] Job ID <<<UUID>>>"

import path from 'node:path';
import fs from 'node:fs/promises';
import findProcess from 'find-process';
import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'

const workerProcessName = 'Runner.Worker';

const githubToken = core.getInput('token', {required: true});

const github = getOctokit(githubToken);

const job = await determineJob();
console.log("job:", job);

// -----------------------------

async function determineWorkerJobId() {
    const workerProcess = await findProcess('name', workerProcessName).then((list) => {
        if (list.length !== 1) {
            throw new Error(`Expected exactly one process with name ${workerProcessName}, found: ${list.length}`);
        }
        return list[0];
    });

    const runnerDir = workerProcess.bin.substring(
        0, workerProcess.bin.indexOf(path.join("bin", workerProcessName)));
    if (!runnerDir) {
        throw new Error(`Unable to extract runner dir from runner bin ${workerProcess.bin}`);
    }

    const diagDir = path.join(runnerDir, "_diag");
    const workerLogFiles = await fs.readdir(diagDir)
        .then((files) => files.filter((file) => file.match(/^Worker_.+\.log/)))
        .then((files) => files.sort().reverse().map((file) => path.join(diagDir, file)));
    if (workerLogFiles.length === 0) {
        throw new Error(`Unable to locate any worker log file at ${diagDir}`);
    }

    for (const logFile of workerLogFiles) {
        const content = await fs.readFile(logFile, "utf8");
        const lines = content.split("\n");
        for (const line of lines) {
            // job id log line example:
            // [2025-05-27 07:22:03Z INFO JobRunner] Job ID 2518fc7c-45ed-5e76-9d00-193312359895
            const jobId = line.match(/\[[^\]]+INFO JobRunner\] Job ID (?<jobId>\S+)/)?.groups?.jobId
            if (jobId) {
                return jobId;
            }
        }
    }

    throw new Error(`Unable to find the worker job ID in worker log files`);
}

async function determineJob() {
    const workerJobId = await determineWorkerJobId();
    console.log("workerJobId:", workerJobId)

    const workflowRun = await github.rest.actions.getWorkflowRun({
        ...context.repo,
        run_id: context.runId,
    }).then((res) => res.data);

    const checkRun = await github.rest.checks.listForSuite({
        ...context.repo,
        check_suite_id: workflowRun.check_suite_id,
        // check_name: context.job,
        status: "in_progress",
        filter: "latest",
    }).then((res) => res.data.check_runs.find((checkRun) => checkRun.external_id == workerJobId));
    if (!checkRun) {
        throw new Error(`Unable to find check run with external id ${workerJobId}`);
    }

    const job = await github.rest.actions.getJobForWorkflowRun({
        ...context.repo,
        job_id: checkRun.id,
    }).then((res) => res.data);
    if (!job) {
        throw new Error(`Unable to find job with id ${checkRun.id}`);
    }
    return job;
}

async function determineJob2() {
    const runnerName = process.env["RUNNER_NAME"];
    const runnerNumberString = runnerName.match(/^GitHub-Actions-(?<id>\d+)$/)?.groups?.id
    const runnerNumber = runnerNumberString ? parseInt(runnerNumberString, 10) : null;
    return await github.rest.actions.listJobsForWorkflowRunAttempt({
        ...context.repo,
        run_id: context.runId,
        attempt_number: context.runAttempt,
    }).then((res) => res.data.jobs)
        .then((jobs) => {
            jobs = jobs
                .filter((job) => job.status === "in_progress" || job.status === "queued")
                .filter((job) => {
                    // job.runner_group_id 0 represents the GitHub Actions hosted runners
                    if (job.runner_group_id === 0 && job.runner_name === "GitHub Actions") {
                        return job.runner_id === runnerNumber;
                    }
                    return job.runner_name === runnerName;
                });
            if (jobs.length !== 1) {
                throw new Error(`Expected exactly one job with runner name ${runnerName}, found: ${list.length}`);
            }
            return jobs[0];
        });
}

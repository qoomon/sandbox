
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

const workerJobId = await determineWorkerJobId();
console.log("workerJobId:", workerJobId)

const workflowRun = await github.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: context.runId,
}).then((res) => res.data);

const checkRuns = await github.rest.checks.listForSuite({
    ...context.repo,
    check_suite_id: workflowRun.check_suite_id,
    // check_name: context.job,
    status: "in_progress",
    filter: "latest",
}).then((res) => res.data);
console.log("checkRuns:", checkRuns)

const checkRun = checkRuns.check_runs.find((checkRun) => checkRun.external_id == workerJobId);
if(!checkRun){
    throw new Error(`Unable to find check run with external id ${workerJobId}`);
}
console.log("checkRun:", checkRun)


async function determineWorkerJobId(){
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

  for(const logFile of workerLogFiles) {
    const content = await fs.readFile(logFile, "utf8");
    const lines = content.split("\n");
    for(const line of lines) {
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

async function sleep(time) {
  await new Promise((resolve) => setTimeout(resolve, time));
}
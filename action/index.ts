import * as core from '@actions/core';
import * as YAML from 'yaml'
import ky, {HTTPError} from "ky"; // WORKAROUND until @actions/http-client support hooks https://github.com/actions/toolkit/issues/1554
import {SignatureV4} from "@smithy/signature-v4"
import {Sha256} from "@aws-crypto/sha256-js"
import {fromWebToken} from "@aws-sdk/credential-providers";
import {AwsRequestSigner} from "./lib/aws-request-signer";
import {GithubAccessTokenResponse, GithubAppPermissions} from "./lib/types";
import {ensureSimpleRecord} from "./lib/github-utils";

// --- Configuration ---------------------------------------------------------------------------------------------------

const GITHUB_ACCESS_MANAGER_API = {
    service: 'lambda', // 'lambda' for Function URLs or 'execute-api' for ApiGateway,
    baseUrl: new URL("CHANGE-ME"),
    accessRoleArn: "CHANGE-ME",
    region: "CHANGE-ME",
}

// ---------------------------------------------------------------------------------------------------------------------

async function run() {
    const permissions = ensureSimpleRecord(YAML.parse(core.getInput('permissions')))

    const accessToken = await getAccessToken({permissions})
    core.setSecret(accessToken.token)

    core.setOutput('token', accessToken.token)
    core.info('set token as output `token`. Usage ${{ steps.STEP_ID.outputs.token }}')
}

async function errorHandler(error: Error) {
    if (error instanceof HTTPError) {
        const responsePayload = await error.response.json()
        core.setFailed(error.message + " " + JSON.stringify(responsePayload, null, 2))
    } else {
        core.setFailed(error)
    }
}

run().catch(errorHandler)

// ---------------------------------------------------------------------------------------------------------------------

async function getAccessToken({permissions}: { permissions: GithubAppPermissions }) {
    return await ky.post(new URL('/v1/access_tokens', GITHUB_ACCESS_MANAGER_API.baseUrl), {
        json: {permissions},
        headers: {"Authorization": 'Bearer ' + await core.getIDToken('github-actions-access-manager')},
        hooks: {
            beforeRequest: [AwsRequestSigner(new SignatureV4({
                service: GITHUB_ACCESS_MANAGER_API.service,
                region: GITHUB_ACCESS_MANAGER_API.region,
                credentials: fromWebToken({
                    webIdentityToken: await core.getIDToken("sts.amazonaws.com"),
                    roleArn: GITHUB_ACCESS_MANAGER_API.accessRoleArn,
                    durationSeconds: 900, // 15 minutes are the minimum allowed by AWS
                }),
                sha256: Sha256, // WORKAROUND due to https://github.com/aws/aws-sdk-js-v3/issues/3590
            }))],
        },
    }).json<GithubAccessTokenResponse>()
}

import * as core from '@actions/core';
import * as YAML from 'yaml'
import ky, {HTTPError} from "ky"; // WORKAROUND until @actions/http-client support hooks https://github.com/actions/toolkit/issues/1554
import {SignatureV4} from "@smithy/signature-v4"
import {Sha256} from "@aws-crypto/sha256-js"
import {fromWebToken} from "@aws-sdk/credential-providers";
import {AwsRequestSigner} from "./lib/aws-request-signer";
import {GithubAccessTokenResponse, GithubAppPermissions} from "./lib/types";
import {ensureSimpleRecord} from "./lib/github-utils";

// ---------------------------------------------------------------------------------------------------------------------

const GITHUB_ACCESS_MANAGER_API = {
    url: new URL("https://el6yspz5c5.execute-api.eu-central-1.amazonaws.com"),
    accessRoleArn: "arn:aws:iam::856009282719:role/github-access-manager-api-access",
    region: "eu-central-1",
}

// ---------------------------------------------------------------------------------------------------------------------

async function run() {
    const permissions = ensureSimpleRecord(YAML.parse(core.getInput('permissions')))

    const accessToken = await getAccessToken({permissions})

    core.setSecret(accessToken.token)
    core.exportVariable('GITHUB_ACCESS_MANAGER_TOKEN', accessToken.token)
    core.setOutput('token', accessToken.token)
}

async function errorHandler(error: Error) {
    if (error instanceof HTTPError) {
        const responsePayload = await error.response.json()
        core.error(error.message + " " + JSON.stringify(responsePayload, null, 2))
        core.setFailed(`${error.message} - ${responsePayload.message}`)
    } else {
        core.setFailed(error)
    }
}

run().catch(errorHandler)

// ---------------------------------------------------------------------------------------------------------------------

async function getAccessToken({permissions}: { permissions: GithubAppPermissions }) {
    return await ky.post(new URL('/v1/access_tokens', GITHUB_ACCESS_MANAGER_API.url), {
        json: {permissions},
        headers: {"Authorization": 'Bearer ' + await core.getIDToken(GITHUB_ACCESS_MANAGER_API.url.hostname)},
        hooks: {
            beforeRequest: [AwsRequestSigner(new SignatureV4({
                service: 'execute-api',
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

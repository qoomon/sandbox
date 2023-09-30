import * as core from '@actions/core';

import ky, {BeforeRequestHook} from "ky"; // WORKAROUND until @actions/http-client support hooks

import {SignatureV4} from "@smithy/signature-v4"
import {Sha256} from "@aws-crypto/sha256-js"
import {fromWebToken} from "@aws-sdk/credential-providers";
import {AwsRequestSigner} from "./aws-request-signer";

const ACCESS_MANAGER_ENDPOINT = "https://3v3dyfyd4u4oaslq4jvhryccei0whjch.lambda-url.eu-central-1.on.aws"
const ACCESS_MANAGER_ENDPOINT_SIGNER = new SignatureV4({
    service: 'lambda',
    region: 'eu-central-1',
    credentials: fromWebToken({
        webIdentityToken: await core.getIDToken("sts.amazonaws.com"),
        roleArn: "arn:aws:iam::856009282719:role/sandbox-github",
        roleSessionName: "github_actions",
        durationSeconds: 900,
    }),
    sha256: Sha256, // WORKAROUND due to https://github.com/aws/aws-sdk-js-v3/issues/3590
})

// ---------------------------------------------------------------------------------------------------------------------

async function run() {
    const repositories = core.getMultilineInput('repositories')
    const permissions = core.getMultilineInput('permissions').reduce((result, scopePermission) => {
        const [scope, permission] = scopePermission.split(':').map(it => it.trim())
        result[scope] = permission
        return result
    }, {} as { [key: string]: string })

    const accessToken = await getAccessToken({
        repositories,
        permissions,
    })

    core.setSecret(accessToken.token)
    core.exportVariable('GITHUB_ACCESS_MANAGER_TOKEN', accessToken.token)
    core.setOutput('GITHUB_ACCESS_MANAGER_TOKEN', accessToken.token)
}

async function getAccessToken({repositories, permissions}: {
    repositories: string[],
    permissions: any,
}) {
    const githubIdToken = await core.getIDToken("github-access-manager")
    return await ky.post(ACCESS_MANAGER_ENDPOINT, {
            json: {repositories, permissions},
            headers: {
                "Authorization": `Bearer ${githubIdToken}`,
            },
            hooks: {beforeRequest: [AwsRequestSigner(ACCESS_MANAGER_ENDPOINT_SIGNER)],}
        },
    ).json() as { token: string }
}

run().catch(error => {
    core.setFailed(error)
})

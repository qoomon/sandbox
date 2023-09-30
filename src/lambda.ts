import {APIGatewayProxyEventV2, APIGatewayProxyHandlerV2, APIGatewayProxyResultV2, Callback, Context} from 'aws-lambda';
import {getReasonPhrase, StatusCodes} from "http-status-codes";
import {JwtRsaVerifier} from "aws-jwt-verify";
import {APIGatewayProxyEventHeaders} from "aws-lambda/trigger/api-gateway-proxy";
import {Octokit} from "@octokit/rest";
import * as OctokitOpenApiTypes from "@octokit/openapi-types";

import {createAppAuth} from "@octokit/auth-app";
import {JwtPayload} from "aws-jwt-verify/jwt-model";
import YAML from 'yaml'
import {Json, JsonObject} from "aws-jwt-verify/safe-json-parse";

const githubTokenVerifier = JwtRsaVerifier.create({
    issuer: "https://token.actions.githubusercontent.com", // set this to the expected "iss" claim on your JWTs
    audience: 'sts.amazonaws.com', // set this to the expected "aud" claim on your JWTs // TODO set to "github-access-manager"
    jwksUri: 'https://token.actions.githubusercontent.com/.well-known/jwks', // from https://token.actions.githubusercontent.com/.well-known/openid-configuration
})

const githubAppClient = new Octokit({
    authStrategy: createAppAuth,
    auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    }
})

const ACCESS_MANGER_POLICY_VARIABLE_NAME = 'ACCESS_MANGER_POLICY'

export const handler: APIGatewayProxyHandlerV2 = withErrorHandler(errorHandler, async (event, context): Promise<APIGatewayProxyResultV2> => {
    if (event.requestContext.http.path === '/v1/access_token' && event.requestContext.http.method === 'POST') {

        // --- get and parse GitHub identity token from authorization header

        const authorizationHeader = event.headers['Authorization'] || event.headers['X-Authorization'] // TODO check for lowercase also
        if (!authorizationHeader) {
            return jsonErrorResponse(StatusCodes.UNAUTHORIZED, 'Missing authorization header')
        }
        const [authorizationScheme, githubTokenValue] = authorizationHeader.split(' ')
        if (authorizationScheme !== 'Bearer') {
            return jsonErrorResponse(StatusCodes.UNAUTHORIZED, `Unexpected authorization scheme ${authorizationScheme}`)
        }
        const githubToken = await githubTokenVerifier.verify(githubTokenValue, {graceSeconds: 60000000})  // TODO graceSeconds for local development only
            .then(payload => payload as GithubJwtPayload)
            .catch(error => ({error}))
        if ('error' in githubToken) {
            return jsonErrorResponse(StatusCodes.UNAUTHORIZED, githubToken.error.message || 'Unexpected token error')
        }
        console.log("githubToken.sub", githubToken.sub)

        // --- get requested GitHub token permissions

        const requestedTokenPermissions: GithubAppPermissions = event.body ? JSON.parse(event.body) : {
            contents: 'read',
        } // TODO validate body

        // --- get source repository access policy

        const sourceRepository = parseRepository(githubToken.repository)
        const sourceRepositoryAppInstallation = await githubAppClient.apps.getRepoInstallation(sourceRepository)
            .then(res => res.data)

        const neededPermissions: GithubAppPermissions = {
            actions_variables: 'read',
            environments: 'read',
        };
        const missingPermissions = validatePermissions(neededPermissions, sourceRepositoryAppInstallation.permissions)
        if (Object.keys(missingPermissions).length > 0) {
            return jsonErrorResponse(StatusCodes.FORBIDDEN, 'App installation does not have required permissions: ' +
                Object.entries(missingPermissions).map(([scope, permission]) => `${scope}:${permission}`).join(', '))
        }

        const sourceRepositoryAccessToken = await githubAppClient.apps.createInstallationAccessToken({
            installation_id: sourceRepositoryAppInstallation.id,
            repository: [sourceRepository.repo],
            permissions: neededPermissions,
        }).then(res => res.data)
        const sourceRepositoryClient = new Octokit({auth: sourceRepositoryAccessToken.token});
        const sourceRepositoryAccessPolicy = await getRepositoryAccessPolicy(sourceRepositoryClient, sourceRepository)
        console.log("sourceRepositoryAccessPolicy", sourceRepositoryAccessPolicy)

        // --- check if source repository access policy grants requested token permissions
        // TODO check if sourceRepositoryAccessPolicy grant requestedTokenPermissions

        // --- create requested GitHub access token

        const accessToken = await githubAppClient.apps.createInstallationAccessToken({
            installation_id: sourceRepositoryAppInstallation.id,
            // be aware that an empty array will result in requesting permissions for all repositories
            repositories: requireNotEmpty([sourceRepository.repo]),
            // be aware that an empty object will result in requesting all granted permissions
            permissions: requireNotEmpty(requestedTokenPermissions),
        }).then(res => res.data)

        // --- response with GitHub access token
        return jsonResponse(StatusCodes.OK, {
            token: accessToken.token,
            expires_at: accessToken.expires_at,
            repositories: accessToken.repositories?.map(it => it.full_name),
            permissions: accessToken.permissions,
        })
    }

    return jsonErrorResponse(StatusCodes.NOT_FOUND)
})

// --- Github Utils ----------------------------------------------------------------------------------------------------

function parseRepository(repository: string) {
    const [owner, repo] = repository.split('/')
    return {owner, repo}
}

function validatePermissions(requested: GithubAppPermissions, granted: GithubAppPermissions) {
    const permissionRanking = ['read', 'write', 'admin']

    const missingPermissions = {} as GithubAppPermissions
    for (const [scope, requestedPermission] of Object.entries(requested)) {
        const grantedPermission = (granted as any)[scope];

        const requestedPermissionRank = permissionRanking.indexOf(requestedPermission)
        const grantedPermissionRank = permissionRanking.indexOf(grantedPermission)

        if (requestedPermissionRank > grantedPermissionRank) {
            (missingPermissions as any)[scope] = requestedPermission
        }
    }

    return missingPermissions
}

async function getRepositoryAccessPolicy(client: Octokit, {owner, repo}: GithubRepository) {
    const variable = await client.actions.getRepoVariable({
        owner, repo,
        name: ACCESS_MANGER_POLICY_VARIABLE_NAME,
        headers: {'X-GitHub-Api-Version': '2022-11-28'},
    }).then(response => response.data)
        .catch(error => {
            if (error.status === 404) return null
            throw error
        })

    return variable ? await YAML.parse(variable.value) : null;
    // TODO check if sourceRepositoryAccessPolicy is valid
}


function requireNotEmpty<T extends Object>(value: T) {
    if (Object.keys(value).length === 0) {
        throw Error("Illegal argument, cannot be empty")
    }

    return value;
}

// ---Lambda Utils -----------------------------------------------------------------------------------------------------

async function errorHandler(error: any, event: APIGatewayProxyEventV2, context: Context) {
    console.error('[ERROR]', error)
    return jsonErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR, "Unexpected error")
}

function withErrorHandler(errorHandler: (error: any, event: APIGatewayProxyEventV2, context: Context) => any, handler: APIGatewayProxyHandlerV2): APIGatewayProxyHandlerV2 {
    return (async (event, context, callback) => {
        try {
            return await handler(event, context, callback)
        } catch (error: any) {
            return await errorHandler(error, event, context)
        }
    })
}

function jsonResponse(statusCode: number, body: any) {
    return {
        statusCode,
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body, null, 2)
    }
}

function jsonErrorResponse(statusCode: number, message?: string) {
    return jsonResponse(statusCode, {
        error: {
            reason: getReasonPhrase(statusCode),
            message,
        }
    })
}

// --- Types -----------------------------------------------------------------------------------------------------------

type GithubRepository = { owner: string, repo: string }
type GithubAppPermissions = OctokitOpenApiTypes.components["schemas"]["app-permissions"] & {
    actions_variables?: 'read' | 'write'
}

type ActionsGetVariableResponse = { name: string, value: string, created_at: string, updated_at: string }

type GithubJwtPayload = JwtPayload & {
    sub: string,// e.g. "repo:qoomon/sandbox:ref:refs/heads/aws-github-access-manager",
    ref: string,// e.g. "refs/heads/aws-github-access-manager",
    sha: string,// e.g. "a61bd32ec51ea98212227f4bff728667f0ae340e",
    repository: string,// e.g. "qoomon/sandbox",
    repository_owner: string,// e.g. "qoomon",
    repository_owner_id: string,// e.g. "3963394",
    run_id: string,// e.g. "6370333187",
    run_number: string,// e.g. "107",
    run_attempt: string,// e.g. "4",
    repository_visibility: string,// e.g. "private",
    repository_id: string,// e.g. "35282741",
    actor_id: string,// e.g. "3963394",
    actor: string,// e.g. "qoomon",
    workflow: string,// e.g. "GitHub Actions Access Manager Example",
    head_ref: string,// e.g. "",
    base_ref: string,// e.g. "",
    event_name: string,// e.g. "push",
    ref_protected: string,// e.g. "false",
    ref_type: string,// e.g. "branch",
    workflow_ref: string,// e.g. "qoomon/sandbox/.github/workflows/github_actions_access_manager.example.yml@refs/heads/aws-github-access-manager",
    workflow_sha: string,// e.g. "a61bd32ec51ea98212227f4bff728667f0ae340e",
    job_workflow_ref: string,// e.g. "qoomon/sandbox/.github/workflows/github_actions_access_manager.example.yml@refs/heads/aws-github-access-manager",
    job_workflow_sha: string,// e.g. "a61bd32ec51ea98212227f4bff728667f0ae340e",
    runner_environment: string,// e.g. "github-hosted",
}


// --- FOR LOCAL DEVELOPMENT ONLY --------------------------------------------------------------------------------------

// TODO do not execute in lmabda environment
const response = await handler({
        requestContext: {
            http: {
                path: '/v1/access_token',
                method: 'POST',
            }
        },
        headers: {
            'X-Authorization': 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6ImVCWl9jbjNzWFlBZDBjaDRUSEJLSElnT3dPRSIsImtpZCI6Ijc4MTY3RjcyN0RFQzVEODAxREQxQzg3ODRDNzA0QTFDODgwRUMwRTEifQ.eyJqdGkiOiJlMTI5NGYxYi1iODM3LTQ5YzktOTFmYy1kMWJjNjFmMTZiYjQiLCJzdWIiOiJyZXBvOnFvb21vbi9zYW5kYm94OnJlZjpyZWZzL2hlYWRzL2F3cy1naXRodWItYWNjZXNzLW1hbmFnZXIiLCJhdWQiOiJzdHMuYW1hem9uYXdzLmNvbSIsInJlZiI6InJlZnMvaGVhZHMvYXdzLWdpdGh1Yi1hY2Nlc3MtbWFuYWdlciIsInNoYSI6ImE2MWJkMzJlYzUxZWE5ODIxMjIyN2Y0YmZmNzI4NjY3ZjBhZTM0MGUiLCJyZXBvc2l0b3J5IjoicW9vbW9uL3NhbmRib3giLCJyZXBvc2l0b3J5X293bmVyIjoicW9vbW9uIiwicmVwb3NpdG9yeV9vd25lcl9pZCI6IjM5NjMzOTQiLCJydW5faWQiOiI2MzcwMzMzMTg3IiwicnVuX251bWJlciI6IjEwNyIsInJ1bl9hdHRlbXB0IjoiNSIsInJlcG9zaXRvcnlfdmlzaWJpbGl0eSI6InByaXZhdGUiLCJyZXBvc2l0b3J5X2lkIjoiMzUyODI3NDEiLCJhY3Rvcl9pZCI6IjM5NjMzOTQiLCJhY3RvciI6InFvb21vbiIsIndvcmtmbG93IjoiR2l0SHViIEFjdGlvbnMgQWNjZXNzIE1hbmFnZXIgRXhhbXBsZSIsImhlYWRfcmVmIjoiIiwiYmFzZV9yZWYiOiIiLCJldmVudF9uYW1lIjoicHVzaCIsInJlZl9wcm90ZWN0ZWQiOiJmYWxzZSIsInJlZl90eXBlIjoiYnJhbmNoIiwid29ya2Zsb3dfcmVmIjoicW9vbW9uL3NhbmRib3gvLmdpdGh1Yi93b3JrZmxvd3MvZ2l0aHViX2FjdGlvbnNfYWNjZXNzX21hbmFnZXIuZXhhbXBsZS55bWxAcmVmcy9oZWFkcy9hd3MtZ2l0aHViLWFjY2Vzcy1tYW5hZ2VyIiwid29ya2Zsb3dfc2hhIjoiYTYxYmQzMmVjNTFlYTk4MjEyMjI3ZjRiZmY3Mjg2NjdmMGFlMzQwZSIsImpvYl93b3JrZmxvd19yZWYiOiJxb29tb24vc2FuZGJveC8uZ2l0aHViL3dvcmtmbG93cy9naXRodWJfYWN0aW9uc19hY2Nlc3NfbWFuYWdlci5leGFtcGxlLnltbEByZWZzL2hlYWRzL2F3cy1naXRodWItYWNjZXNzLW1hbmFnZXIiLCJqb2Jfd29ya2Zsb3dfc2hhIjoiYTYxYmQzMmVjNTFlYTk4MjEyMjI3ZjRiZmY3Mjg2NjdmMGFlMzQwZSIsInJ1bm5lcl9lbnZpcm9ubWVudCI6ImdpdGh1Yi1ob3N0ZWQiLCJpc3MiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwibmJmIjoxNjk2MTYzNzQ3LCJleHAiOjE2OTYxNjQ2NDcsImlhdCI6MTY5NjE2NDM0N30.lOhRK-8lp3eDsWwGAksbmHxk8FU1yiz8vPtat6t-esBhgMLNZ5RilmNlEJ-dNcC5O9q5JcdTU3iOcnCizHj9rlSj7yYKEd3-vqcYm18qGtGJrc0IWqbizA9n6yOxX9KklYzNqdEKyHUdSr64CE5lLDW3GUGxscQD7J6Nd0QRb6zvCgQnthOp8-7DdAvQjn6VCetgKuXIMEgkOPM7r2WMXjpY-vn_vB1gOThvj2QAHTrG7TYtOK3XUX1_ROS9v_sl_4kDFGNHF9dOZmoTDAWBxYpAHtK237MOgTtacZfmYsdaqtfWBHLmXoVIhVRr-h9_qe7vFvstNacQwBXGAoeGRA'
        } as APIGatewayProxyEventHeaders
    } as APIGatewayProxyEventV2,
    {} as Context,
    {} as Callback)

console.log(response)

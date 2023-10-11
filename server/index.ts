import {APIGatewayProxyEventV2, APIGatewayProxyHandlerV2, APIGatewayProxyResultV2, Context} from 'aws-lambda';
import {getReasonPhrase, StatusCodes} from "http-status-codes";
import {JwtRsaVerifier} from "aws-jwt-verify";
import {Octokit} from "@octokit/rest";
import {createAppAuth} from "@octokit/auth-app";
import {
    AccessTokensRequestBodySchema,
    GithubActionJwtPayload,
    GithubAppPermission,
    GithubAppPermissions,
    GithubRepoAccessPolicy,
    GithubRepoAccessPolicySchema,
    GitHubRepoAccessStatement,
    JsonTransformer,
    YamlTransformer
} from "./lib/types";
import {
    getSecretObject,
    jsonErrorResponse,
    jsonResponse,
    withErrorHandler
} from "./lib/lambda-utils";
import {comparePermission, ensureSameRepositoryOwner, parseRepository} from "./lib/github-utils";
import {ZodTypeAny} from "zod/lib/types";
import {ensureNotEmpty, formatKey, wildcardRegExp} from "./lib/common-utils";
import {ZodError} from "zod";

// ---------------------------------------------------------------------------------------------------------------------

const API_ENDPOINT_URL = new URL(process.env["API_ENDPOINT_URL"]!);
const GITHUB_ACTIONS_TOKEN_SUB_WHITELIST = [].map(it => wildcardRegExp(it)) // allow all if empty
const GITHUB_APP_SECRETS = await getSecretObject<{
    appId: string,
    privateKey: string
}>(process.env["GITHUB_APP_SECRETS_NAME"]!).then(it => {
    // due to aws secret manager limitation to store multiline strings we need to format the key
    it.privateKey = formatKey(it.privateKey)
    return it
})

const GITHUB_ACTIONS_TOKEN_VERIFIER = JwtRsaVerifier.create({
    issuer: "https://token.actions.githubusercontent.com", // set this to the expected "iss" claim on your JWTs
    jwksUri: 'https://token.actions.githubusercontent.com/.well-known/jwks', // from get from ISSUER/.well-known/openid-configuration > $.jwks_uri
    audience: API_ENDPOINT_URL.hostname // set this to the expected "aud" claim on your JWTs
})

const GITHUB_APP_CLIENT = new Octokit({authStrategy: createAppAuth, auth: GITHUB_APP_SECRETS})
const GITHUB_APP_INFOS = await GITHUB_APP_CLIENT.apps.getAuthenticated().then(it => it.data)
// https://github.com/OWNER/REPO/settings/variables/actions/ACCESS_MANGER_POLICY
const ACCESS_MANAGER_POLICY_VARIABLE_NAME: string = 'ACCESS_MANAGER_POLICY'

// ---------------------------------------------------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = withErrorHandler(errorHandler, async (event, _context): Promise<APIGatewayProxyResultV2> => {
    const requestIdentity = await handleAuthorization(event.headers)
    console.info("requestIdentity.sub:", requestIdentity.sub)

    if (event.requestContext.http.path === '/v1/access_tokens') {
        if (event.requestContext.http.method === 'POST') {
            const requestBody = await parseJsonBody(event.body, AccessTokensRequestBodySchema)
            console.info("requestBody:", requestBody)
            // TODO maybe refactor
            const requestTargetRepository = requestBody.repository ?? requestIdentity.repository


            // --- get target repository app installation

            const targetRepoInstallation = await getAppInstallation({
                repository: requestTargetRepository
            })
            if (!targetRepoInstallation) {
                throw new APIClientError(StatusCodes.FORBIDDEN, `${GITHUB_APP_INFOS.name} is not installed for ${requestTargetRepository} repository`, {
                    details: {html_url: GITHUB_APP_INFOS.html_url}
                })
            }

            // --- check if target repository installation grants requested token permissions

            const targetRepoInstallationDeniedPermissions = verifyPermissions(requestBody.permissions, targetRepoInstallation.permissions)
            if (targetRepoInstallationDeniedPermissions) {
                throw new APIClientError(StatusCodes.FORBIDDEN, `The permissions requested are not granted to ${GITHUB_APP_INFOS.name} installation for ${requestTargetRepository} repository.`, {
                    details: {deniedPermission: targetRepoInstallationDeniedPermissions}
                })
            }

            // --- get target repository access policy and granted permissions

            const targetRepositoryClient = await createInstallationOctokit({
                installation_id: targetRepoInstallation.id,
                repositories: [requestTargetRepository],
                permissions: {actions_variables: 'read'} as GithubAppPermissions,  // needed to read repository access policy
            })

            const targetRepositoryGrantedPermissions = await getRepositoryAccessPermissions({
                repositoryClient: targetRepositoryClient,
                repository: requestTargetRepository,
                identity: requestIdentity
            }).catch(error => {
                // TODO refactor
                if (error instanceof ZodError) {
                    throw new APIClientError(StatusCodes.FORBIDDEN, `${requestTargetRepository} repository has an invalid access policy`, {
                        // only return details, if the target repository is the same as request identity repository
                        details: requestTargetRepository === requestIdentity.repository ? error.issues : undefined,
                        cause: error,
                    })
                }
                throw error
            })

            // --- check if source repository access policy grants requested token permissions

            const targetRepositoryDeniedPermissions = verifyPermissions(requestBody.permissions, targetRepositoryGrantedPermissions)
            if (targetRepositoryDeniedPermissions) {
                throw new APIClientError(StatusCodes.FORBIDDEN, `The permissions requested are not granted to github action principal ${requestIdentity.sub}`, {
                    details: {declinedPermission: targetRepositoryDeniedPermissions}
                })
            }

            // --- create requested GitHub access token

            const accessToken = await createInstallationAccessToken({
                installation_id: targetRepoInstallation.id,
                // be aware that an empty array will result in requesting permissions for all repositories
                repositories: ensureNotEmpty([requestTargetRepository]),
                // be aware that an empty object will result in requesting all granted permissions
                permissions: ensureNotEmpty(requestBody.permissions),
            })

            // --- response with GitHub access token

            return jsonResponse(StatusCodes.OK, {
                token: accessToken.token,
                expires_at: accessToken.expires_at,
                repositories: accessToken.repositories?.map(it => it.full_name),
                permissions: accessToken.permissions,
            })
        }

        throw new APIClientError(StatusCodes.METHOD_NOT_ALLOWED)
    }

    throw new APIClientError(StatusCodes.NOT_FOUND)
})

async function handleAuthorization(headers: Record<string, string | undefined>): Promise<GithubActionJwtPayload> {
    // --- get and parse GitHub identity token from authorization header
    // if the API is secured by AWS IAM authorizer the 'authorization' header is already occupied by the AWS IAM token,
    // so we use the 'x-authorization' header instead
    const authorizationHeader = headers['x-authorization'] || headers['authorization']
    if (!authorizationHeader) {
        throw new APIClientError(StatusCodes.UNAUTHORIZED, 'Missing authorization header')
    }

    const [authorizationScheme, githubTokenValue] = authorizationHeader.split(' ')
    if (authorizationScheme !== 'Bearer') {
        throw new APIClientError(StatusCodes.UNAUTHORIZED, `Unexpected authorization scheme ${authorizationScheme}`)
    }

    const githubToken = await GITHUB_ACTIONS_TOKEN_VERIFIER.verify(githubTokenValue)
        .then(payload => payload as GithubActionJwtPayload)
        .catch(error => {
            throw new APIClientError(StatusCodes.UNAUTHORIZED, error?.message || 'Unexpected token error') // TODO check if error can contain sensitive information
        })

    if (GITHUB_ACTIONS_TOKEN_SUB_WHITELIST.length && !GITHUB_ACTIONS_TOKEN_SUB_WHITELIST.some(subRegex => subRegex.test(githubToken.sub))) {
        throw new APIClientError(StatusCodes.UNAUTHORIZED, `Unexpected token sub ${githubToken.sub}`)
    }

    return githubToken
}

async function parseJsonBody<T extends ZodTypeAny>(body: string | undefined, schema: T) {

    const parseResult = JsonTransformer
        .pipe(schema).safeParse(body)

    if (!parseResult.success) {
        throw new APIClientError(StatusCodes.BAD_REQUEST, "Invalid request body", {
            details: parseResult.error?.issues,
            cause: parseResult.error
        })
    }

    return parseResult.data
}

async function errorHandler(error: any, _event: APIGatewayProxyEventV2, _context: Context) {
    console.error('[ERROR]', error)

    if (error instanceof APIClientError) {
        return jsonErrorResponse(error.statusCode, error.message, error.details)
    }

    return jsonErrorResponse(StatusCodes.INTERNAL_SERVER_ERROR)
}

export class APIClientError extends Error {
    public details?: any;

    constructor(public statusCode: number, message?: string, options?: { details?: any, cause?: Error }) {
        super(message ?? getReasonPhrase(statusCode), {
            cause: options?.cause
        });
        this.details = options?.details;

        if (statusCode < 400 || statusCode >= 500) {
            throw Error(`Illegal argument, error statusCode must be >= 400, but was ${statusCode}`)
        }
    }
}

// --- GutHub App Functions---------------------------------------------------------------------------------------------

async function getAppInstallation({repository}: { repository: string }) {
    return await GITHUB_APP_CLIENT.apps
        .getRepoInstallation(parseRepository(repository))
        .then(res => res.data)
        .catch(async error => {
            if (error.status === StatusCodes.NOT_FOUND) return null
            throw error
        })
}

async function createInstallationAccessToken({installation_id, repositories, permissions}: {
    installation_id: number,
    repositories: string[],
    permissions: GithubAppPermissions
}) {
    return await GITHUB_APP_CLIENT.apps.createInstallationAccessToken({
        installation_id,
        repositories: ensureSameRepositoryOwner(repositories)
            .map(repository => parseRepository(repository).repo),
        permissions,
    }).then(res => res.data);
}

async function createInstallationOctokit(params: {
    installation_id: number,
    repositories: string[],
    permissions: GithubAppPermissions
}) {
    const accessToken = await createInstallationAccessToken(params)
    return new Octokit({auth: accessToken.token})
}


// --- Permission & Access Policy Functions ----------------------------------------------------------------------------

/**
 * Verify if requested permissions are granted
 * @param requested permissions
 * @param granted permissions
 * @return denied permissions or null if all permissions are granted
 */
function verifyPermissions(requested: GithubAppPermissions, granted: GithubAppPermissions) {
    const deniedPermissions = {} as GithubAppPermissions
    for (const [scope, requestedPermission] of Object.entries(requested) as [keyof GithubAppPermissions, GithubAppPermission][]) {
        if (comparePermission(requestedPermission, granted[scope]) < 0) {
            // @ts-ignore
            missingPermissions[scope] = requestedPermission
        }
    }
    if (Object.keys(deniedPermissions).length > 0) {
        return deniedPermissions
    }
    return null
}

async function getRepositoryAccessPermissions({repositoryClient, repository, identity}: {
    repositoryClient: Octokit,
    repository: string,
    identity: GithubActionJwtPayload,
}): Promise<GithubAppPermissions> {
    const targetRepositoryAccessPolicy = await getRepositoryAccessPolicy({
        repositoryClient, repository,
    })
    return determineGrantedPermissions(targetRepositoryAccessPolicy, identity)
}

async function getRepositoryAccessPolicy({repositoryClient, repository}: {
    repositoryClient: Octokit,
    repository: string
}): Promise<GithubRepoAccessPolicy> {
    const variable = await repositoryClient.actions
        .getRepoVariable({...parseRepository(repository), name: ACCESS_MANAGER_POLICY_VARIABLE_NAME})
        .then(it => it.data)
        .catch(error => {
            if (error.status === StatusCodes.NOT_FOUND) return null
            throw error
        })
    if (!variable) {
        return {statements: []}
    }

    const accessPolicyResult = YamlTransformer
        .pipe(GithubRepoAccessPolicySchema).safeParse(variable.value)

    if (!accessPolicyResult.success) {
        throw accessPolicyResult.error
    }
    return accessPolicyResult.data
}

function determineGrantedPermissions(accessPolicy: GithubRepoAccessPolicy, identity: GithubActionJwtPayload) {
    const permissionsSets = accessPolicy.statements
        .filter((statement: GitHubRepoAccessStatement) => statement.principal.some(principalPattern => {
            if (!principalPattern.startsWith("repo:")) {
                principalPattern = `repo:${identity.repository}:` + principalPattern
            }

            // principalPattern reference type (repo:___:REFERENCE_TYPE:___) must not contain wildcards
            if (principalPattern.split(':')[2]?.includes('*')) {
                return false
            }

            // principalPattern example: repo:qoomon/sandbox:ref:refs/heads/*
            // identity.sub example:     repo:qoomon/sandbox:ref:refs/heads/main
            return wildcardRegExp(principalPattern).test(identity.sub)
        }))
        .map(it => it.permissions);
    return aggregatePermissions(permissionsSets)
}

/**
 * Aggregate permission sets, the most permissive permission is applied
 * @param permissionSets
 * @return aggregated permissions
 */
function aggregatePermissions(permissionSets: GithubAppPermissions[]) {
    const resultingPermissions = {} as GithubAppPermissions
    for (const permissions of permissionSets) {
        for (const [scope, permission] of Object.entries(permissions) as [keyof GithubAppPermissions, GithubAppPermission][]) {
            if (comparePermission(resultingPermissions[scope], permission) > 0) {
                //@ts-ignore
                resultingPermissions[scope] = permission
            }
        }
    }
    return resultingPermissions
}

import {
    APIGatewayEventRequestContextV2,
    APIGatewayProxyEventV2,
    APIGatewayProxyEventV2WithRequestContext,
    APIGatewayProxyHandlerV2,
    APIGatewayProxyResultV2,
    Context
} from 'aws-lambda';
import {getReasonPhrase, StatusCodes} from "http-status-codes";
import {JwtRsaVerifier} from "aws-jwt-verify";
import {JwtInvalidClaimError} from "aws-jwt-verify/error";
import {Octokit} from "@octokit/rest";
import {createAppAuth} from "@octokit/auth-app";
import {
    AccessTokensRequestBodySchema,
    GithubActionJwtPayload,
    GitHubAppCredentials,
    GithubAppPermission,
    GithubAppPermissions,
    GithubRepoAccessPolicy,
    GithubRepoAccessPolicySchema,
    GitHubRepoAccessStatement,
    JsonTransformer, PolicyError,
    YamlTransformer
} from "./lib/types";
import {getSecretObject, jsonErrorResponse, jsonResponse, withErrorHandler} from "./lib/lambda-utils";
import {comparePermission, ensureSameRepositoryOwner, parseRepository} from "./lib/github-utils";
import {ZodTypeAny} from "zod/lib/types";
import {ensureNotEmpty, formatKey, wildcardRegExp} from "./lib/common-utils";

// --- configure -------------------------------------------------------------------------------------------------------

const ACCESS_MANAGER_POLICY_FILE_PATH = '.github/access-manager.yaml'

// ---------------------------------------------------------------------------------------------------------------------

const GITHUB_ACTIONS_TOKEN_SUB_WHITELIST = [] // allow all, if empty
    .map(subPattern => wildcardRegExp(subPattern))

const GITHUB_APP_SECRETS = await getSecretObject<GitHubAppCredentials>(process.env["GITHUB_APP_SECRETS_NAME"]!)
// due to aws secret manager limitation to store multiline strings we need to format the key
GITHUB_APP_SECRETS.privateKey = formatKey(GITHUB_APP_SECRETS.privateKey)

const GITHUB_APP_CLIENT = new Octokit({authStrategy: createAppAuth, auth: GITHUB_APP_SECRETS})
const GITHUB_APP_INFOS = await GITHUB_APP_CLIENT.apps.getAuthenticated().then(it => it.data)

const GITHUB_ACTIONS_TOKEN_VERIFIER = JwtRsaVerifier.create({
    issuer: "https://token.actions.githubusercontent.com", // set this to the expected "iss" claim on your JWTs
    jwksUri: 'https://token.actions.githubusercontent.com/.well-known/jwks', // from get from ISSUER/.well-known/openid-configuration > $.jwks_uri
    audience: "github-actions-access-manager" // set this to the expected "aud" claim on your JWTs
})

// ---------------------------------------------------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = withErrorHandler(handleError, async (event, _context): Promise<APIGatewayProxyResultV2> => {
    // --- handle authorization ----------------------------------------------------------------------------------------
    const requestIdentity = await handleAuthorization(event.headers)
    console.info("requestIdentity.sub:", requestIdentity.sub)

    if (event.requestContext.http.path === '/v1/access_tokens') {
        if (event.requestContext.http.method === 'POST') {
            // --- handle input ----------------------------------------------------------------------------------------
            const request = await handleInput(event, requestIdentity)
            console.info("request:", request)

            // --- process access token request ------------------------------------------------------------------------

            // --- get target repository app installation

            const targetRepoInstallation = await getAppInstallation({
                repository: request.targetRepository
            })
            if (!targetRepoInstallation) {
                throw new APIClientError(StatusCodes.FORBIDDEN, `'${GITHUB_APP_INFOS.name}' is not installed for ${request.targetRepository} repository`, {
                    details: {html_url: GITHUB_APP_INFOS.html_url}
                })
            }

            // --- check if target repository installation grants requested token permissions

            const targetRepoInstallationDeniedPermissions = verifyPermissions({
                requested: request.permissions,
                granted: targetRepoInstallation.permissions,
            })
            if (targetRepoInstallationDeniedPermissions) {
                throw new APIClientError(StatusCodes.FORBIDDEN, `The permissions requested are not granted to '${GITHUB_APP_INFOS.name}' installation for '${request.targetRepository}' repository.`, {
                    details: {deniedPermission: targetRepoInstallationDeniedPermissions}
                })
            }

            // --- get target repository access policy and granted permissions

            const targetRepositoryClient = await createInstallationOctokit({
                installation_id: targetRepoInstallation.id,
                repositories: [request.targetRepository],
                permissions: {
                    single_file: 'read', // needed to read repository access policy file ACCESS_MANAGER_POLICY_FILE_PATH
                } as GithubAppPermissions,
            })

            const targetRepositoryGrantedPermissions = await getRepositoryAccessPermissions({
                repositoryClient: targetRepositoryClient,
                repository: request.targetRepository,
                identity: requestIdentity
            }).catch(error => {
                if (error instanceof PolicyError) {
                    throw new APIClientError(StatusCodes.FORBIDDEN, `'${request.targetRepository}' repository has an invalid access policy`, {
                        // only return details, if the target repository is the same as request identity repository
                        details: request.targetRepository === requestIdentity.repository ? error.issues : undefined,
                        cause: error,
                    })
                }
                throw error
            })

            // --- check if source repository access policy grants requested token permissions

            const targetRepositoryDeniedPermissions = verifyPermissions({
                requested: request.permissions,
                granted: targetRepositoryGrantedPermissions,
            })
            if (targetRepositoryDeniedPermissions) {
                throw new APIClientError(StatusCodes.FORBIDDEN, `The permissions requested are not granted to github action principal '${requestIdentity.sub}'`, {
                    details: {declinedPermission: targetRepositoryDeniedPermissions}
                })
            }

            // --- create requested GitHub access token

            const accessToken = await createInstallationAccessToken({
                installation_id: targetRepoInstallation.id,
                // be aware that an empty array will result in requesting permissions for all repositories
                repositories: ensureNotEmpty([request.targetRepository]),
                // be aware that an empty object will result in requesting all granted permissions
                permissions: ensureNotEmpty(request.permissions),
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
        .then(it => it as GithubActionJwtPayload)
        .catch(error => {
            if (error instanceof JwtInvalidClaimError) {
                throw new APIClientError(StatusCodes.UNAUTHORIZED, error.message)
            }
            throw error
        })

    if (GITHUB_ACTIONS_TOKEN_SUB_WHITELIST.length && !GITHUB_ACTIONS_TOKEN_SUB_WHITELIST.some(subRegex => subRegex.test(githubToken.sub))) {
        throw new APIClientError(StatusCodes.UNAUTHORIZED, `Unexpected token sub ${githubToken.sub}`)
    }

    return githubToken
}

async function handleInput(event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2>, requestIdentity: GithubActionJwtPayload) {
    return await parseJsonBody(event.body, AccessTokensRequestBodySchema)
        .then(request => ({
            permissions: request.permissions,
            targetRepository: request.repository || requestIdentity.repository
        }));
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

async function handleError(error: any, _event: APIGatewayProxyEventV2, _context: Context) {
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
function verifyPermissions({requested, granted}: { requested: GithubAppPermissions, granted: GithubAppPermissions }) {
    const deniedPermissions = {} as GithubAppPermissions
    for (const [scope, requestedPermission] of Object.entries(requested) as [keyof GithubAppPermissions, GithubAppPermission][]) {
        if (comparePermission(requestedPermission, granted[scope]) < 0) {
            (deniedPermissions[scope] as string) = requestedPermission
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

    const policyValue = await repositoryClient.repos
        .getContent({
            ...parseRepository(repository),
            path: ACCESS_MANAGER_POLICY_FILE_PATH
        })
        .then(res => Buffer.from((res.data as { content: string }).content, 'base64').toString())
        .catch(error => {
            if (error.status === StatusCodes.NOT_FOUND) return null
            throw error
        })

    if (!policyValue) {
        return {self: repository, statements: []}
    }

    const accessPolicyResult = YamlTransformer
        .pipe(GithubRepoAccessPolicySchema).safeParse(policyValue)

    if (!accessPolicyResult.success) {
        throw new PolicyError('Invalid access policy', accessPolicyResult.error.issues
            .map(issue => `${issue.path.join('.')}: ${issue.message}`))
    }

    const policy = accessPolicyResult.data
    if (policy.self.toLowerCase() !== repository.toLowerCase()) {
        throw new PolicyError('Invalid access policy', [`policy field 'self' needs to be set to '${repository}'`])
    }

    return policy
}

function determineGrantedPermissions(accessPolicy: GithubRepoAccessPolicy, identity: GithubActionJwtPayload) {
    const permissionsSets = accessPolicy.statements
        .filter((statement: GitHubRepoAccessStatement) => statement.principals.some(principalPattern => {
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
                (resultingPermissions[scope] as string) = permission
            }
        }
    }
    return resultingPermissions
}

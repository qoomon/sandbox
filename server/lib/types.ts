import * as OctokitOpenApiTypes from "@octokit/openapi-types";
import {JwtPayload} from "aws-jwt-verify/jwt-model";
import {z} from "zod";
import YAML from 'yaml'
import {ZodRecord} from "zod/lib/types";

export type GitHubAppCredentials = {
    appId: string,
    privateKey: string,
}

export class PolicyError extends Error {
    public issues?: string[];
    constructor(message:string, issues?: string[]) {
        super(message)
        this.issues = issues;
    }
}

export const GithubAppPermissionSchema = z.enum(['read', 'write', 'admin'])
export type GithubAppPermission = z.infer<typeof GithubAppPermissionSchema>
const GitHubRepoAccessStatementSchema = z.object({
    /**
     * https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#example-subject-claims
     *
     * Filtering for a specific branch
     * Syntax: repo:<orgName/repoName>:ref:refs/heads/branchName
     * Example: repo:octo-org/octo-repo:ref:refs/heads/main
     */
    principals: z.array(z.string()),
    permissions: z.record(GithubAppPermissionSchema),
});
export type GitHubRepoAccessStatement = z.infer<typeof GitHubRepoAccessStatementSchema>
export const GithubRepoAccessPolicySchema = z.object({
    self: z.string(),
    statements: z.array(GitHubRepoAccessStatementSchema)
})
export type GithubRepoAccessPolicy = z.infer<typeof GithubRepoAccessPolicySchema>

export type GithubRepository = { owner: string, repo: string }
export type GithubAppPermissions = OctokitOpenApiTypes.components["schemas"]["app-permissions"] & {
    actions_variables?: 'read' | 'write'
}

export type GithubActionJwtPayload = JwtPayload & {
    // https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#example-subject-claims
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

export const JsonTransformer = z.string()
    .transform((str, ctx) => {
        try {
            return JSON.parse(str)
        } catch (error: any) {
            ctx.addIssue({code: 'custom', message: error.message})
            return z.NEVER
        }
    })

export const YamlTransformer = z.string()
    .transform((str, ctx) => {
        try {
            return YAML.parse(str)
        } catch (error: any) {
            ctx.addIssue({code: 'custom', message: error.message})
            return z.NEVER
        }
    })

const checkNotEmpty = (obj: Object) => Object.values(obj).some(value => value !== undefined)
export const AccessTokensRequestBodySchema = z.object({
    repository: zStringRegex(/^[a-z\d](-?[a-z\d]){0,38}\/[a-z\d-._]{1,40}$/i, 'repository').optional(),
    permissions: z.record(GithubAppPermissionSchema)
        .refine(checkNotEmpty, {message: "Object must have at least 1 entry"}),

})
export type AccessTokensRequestBody = z.infer<typeof AccessTokensRequestBodySchema>;

function zStringRegex(regex: RegExp, fieldName: string) {
    return z.string().regex(regex, `Invalid ${fieldName} value. Expected format: ${regex}`)
}

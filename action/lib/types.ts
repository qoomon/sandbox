export type GithubRepository = { owner: string, repo: string }
export type GithubAppPermissions = { [key: string]: string };
export type GithubAccessTokenResponse = {
    token: string,
    expires_at: string,
    repositories: string[],
    permissions: GithubAppPermissions,
};
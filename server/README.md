# Access-Manager Server

## First Install
- [Initial Deployment](#deployment)
- Create GitHub App
- https://github.com/organizations/ORG/settings/apps/new
    - Select permissions you want to create temporary access tokens for
        - Select at least `Variables` `Access: Read-only`, to read access policy from repo variable e.g. `ACCESS_MANAGER_POLICY`
        - Select at least `Single file` `Access: Read-only`, to read access policy from repo file
            - Add file path to your policy file, e.g. `.github/access-manager.yml`
    - Generate and download a private key
- Update secret values `appId` and `privateKey` in AWS Secrets Manager (get secret name from CDK output `GithubAccessManager.GithubAppSecretName`)
- Adjust GitHub Action `index.ts` config according to CDK output
  ```ts
    const GITHUB_ACCESS_MANAGER_API = {
      url: new URL("<CDK output GithubAccessManager.HttpApiUrl>"),
      accessRoleArn: "<CDK output GithubAccessManager.HttpApiAccessRoleArn>",
      region: "<CDK output GithubAccessManager.HttpApiRegion>",
    }
  ```
- [Create a new GitHub Action release](../action/README.md#release)

## Deployment
```bash
cd infrastracture
# aws sso login --profile XXX
cdk deploy
```

## Access Policy Schema
grant permissions to access own repo
```yaml
statements:
- principals:
  - ref:refs/heads/main
  permissions:
    secrets: write
```

### External access (not implemented yet)
grant permissions to access external repos
```yaml
statements:
- principals: 
  - ref:refs/*
  target: owner/repo
  permissions:
    actions: write
```
grant permissions to external repo actions
```yaml
statements:
  - principals:
      - repo:owner/repo
    permissions:
      actions: write
```
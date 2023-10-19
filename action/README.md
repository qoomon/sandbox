# GitHub Actions Access Manager Action

## Setup
create repository GitHub Actions secret `ACCESS_MANAGER_POLICY` https://github.com/OWNER/REPO/settings/secrets/actions/new

## Example Workflow
```yaml
name: GitHub Actions Access Manager Example
on:
  workflow_dispatch:
  push:
    branches:
      - main

jobs:
  update-secret:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
    
      - name: Get GitHub Access Token from GitHub Access Manager
        uses: qoomon/github-actions-access-manager@v1
        id: access-token
        with:
          permissions: |
              secrets: write

      - name: Update Secret
        run: gh secret set API_KEY --body "Hello-World"
        env:
          GITHUB_TOKEN: ${{ steps.access-token.outputs.token }}

  read-secret:
    needs: update-secret
    runs-on: ubuntu-latest
    steps:
      - run: echo ${{ secrets.API_KEY }}
```

## Release
```bash
RELEASE_VERSION="0.0.0"

npm ci
npm run build

git add -f dist/
git commit -m "build(release): action release $RELEASE_VERSION"
git push

RELEASE_VERSION_TAG="v$RELEASE_VERSION"
git tag -a -m "$RELEASE_VERSION" "$RELEASE_VERSION_TAG"
git push origin "$RELEASE_VERSION_TAG"

# move the major version tag
git tag --force -a -m "$RELEASE_VERSION"  ${RELEASE_VERSION_TAG%%.*} 
git push --force origin  ${RELEASE_VERSION_TAG%%.*} 
```
## Access Policy

### Grant Permissions to Access Own Repo
```yaml
grant permissions to access own repo
```yaml
statements:
- principal:
  - ref:refs/heads/main
  permissions:
    secrets: write
```


## Not Implemented Yet

### External access
#### Grant Permissions to Access External Repo
```yaml
statements:
- principal: 
  - ref:refs/*
  repository: owner/repo
  permissions:
    actions: write
```

#### Grant Permissions to External Repo Actions
```yaml
statements:
- principal:
  - repo:owner/repo
  permissions:
    actions: write
```
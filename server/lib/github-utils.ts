import {GithubAppPermission, GithubRepository} from "./types";

export function parseRepository(repository: string) {
    const [owner, repo] = repository.split('/')
    return {owner, repo} as GithubRepository
}

export function ensureSameRepositoryOwner(repositories: string[]) {
    const ownerSet = new Set(repositories.map(repository => parseRepository(repository).owner))
    if (ownerSet.size > 1) {
        throw new Error(`All repositories must have the same owner, but found ${[...ownerSet].join(', ') }}`)
    }
    return repositories
}

const PERMISSION_RANKING: GithubAppPermission[] = ['read', 'write', 'admin']

export function comparePermission(
    left: GithubAppPermission | undefined,
    right: GithubAppPermission | undefined
): 1 | 0 | -1 {
    if(!left) return +1
    if(!right) return -1

    const leftRank = PERMISSION_RANKING.indexOf(left)
    const rightRank = PERMISSION_RANKING.indexOf(right)

    if(leftRank > rightRank) return -1
    if(leftRank < rightRank) return +1

    return 0
}

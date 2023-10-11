import {GithubRepository} from "./types";

export function ensureSimpleRecord(obj: Record<string, string>, message?: string) {
    if (typeof obj !== 'object' || Array.isArray(obj)
        || Object.values(obj).some(value => value != null && typeof value === 'object')) {
        throw new Error('Invalid argument: ' + (message || 'Expected a simple object'))
    }

    return obj
}

export function parseRepository(repository: string) {
    const [owner, repo] = repository.split('/')
    return {owner, repo} as GithubRepository
}

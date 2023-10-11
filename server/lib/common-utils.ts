export function wildcardRegExp(pattern: string, flags?: string) {
    let regexp = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // regexp escape
        .replace(/\*/g, '.+') // replace * with match one or more characters
        .replace(/\?/g, '.') // replace ? with match one characters
    return new RegExp(`^${regexp}$`, flags);
}

export function ensureNotEmpty<T extends Object>(value: T) {
    if (Object.keys(value).length === 0) throw Error("Illegal argument, cannot be empty")
    return value;
}

/**
 * This function will format a single line key to a multi line key
 * e.g. format single line key
 * @param keyString
 */
export function formatKey(keyString: string) {
    const headerMatch = keyString.match(/^\s*-----BEGIN [\w\d\s]+ KEY-----/g)
    const footerMatch = keyString.match(/-----END [\w\d\s]+ KEY-----\s*$/g)
    if (!headerMatch || !footerMatch) throw Error("Invalid key format")

    const key = keyString
        .slice(headerMatch[0].length)
        .slice(0, -footerMatch[0].length)
        .replace(/\s+/g, '')

    return headerMatch[0] + "\n"
        + key.replace(/.{1,64}/g, '$&\n')
        + footerMatch[0] + "\n"
}
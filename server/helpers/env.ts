export function getRequiredEnv(key: string): string {
    const value = process.env[key];

    if (!value) {
        throw new Error(`Missing environment variable: ${key}`);
    }

    return value;
}

export function getRequiredNumberEnv(key: string): number {
    const value = getRequiredEnv(key);
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        throw new Error(
            `Environment variable ${key} must be a valid number, received '${value}'`,
        );
    }

    return parsed;
}

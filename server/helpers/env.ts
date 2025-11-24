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

export function getBooleanEnv(key: string, defaultValue = false): boolean {
    const value = process.env[key];

    if (value === undefined) {
        return defaultValue;
    }

    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
        return true;
    }

    if (normalized === 'false') {
        return false;
    }

    throw new Error(
        `Environment variable ${key} must be 'true' or 'false', received '${value}'`,
    );
}

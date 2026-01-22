function sanitizeNamePart(value) {
    let out = String(value ?? "")
        .trim()
        .toLowerCase();
    if (!out)
        return "";
    out = out.replace(/[_ ]+/g, "-");
    out = out.replace(/[^a-z0-9-]+/g, "-");
    out = out.replace(/-+/g, "-");
    out = out.replace(/^-+/, "").replace(/-+$/, "");
    return out;
}
export function normalizeStage(stage) {
    const value = String(stage ?? "")
        .trim()
        .toLowerCase();
    switch (value) {
        case "prod":
        case "production":
        case "live":
            return "live";
        case "dev":
        case "development":
            return "dev";
        case "stg":
        case "stage":
        case "staging":
            return "stage";
        case "test":
        case "testing":
            return "test";
        case "local":
            return "local";
        default:
            return sanitizeNamePart(value);
    }
}
export function baseName(appName, stage, tenant = "") {
    const app = sanitizeNamePart(appName);
    const ten = sanitizeNamePart(tenant);
    const stg = normalizeStage(stage);
    return ten ? `${app}-${ten}-${stg}` : `${app}-${stg}`;
}
export function resourceName(appName, resource, stage, tenant = "") {
    const app = sanitizeNamePart(appName);
    const ten = sanitizeNamePart(tenant);
    const res = sanitizeNamePart(resource);
    const stg = normalizeStage(stage);
    return ten ? `${app}-${ten}-${res}-${stg}` : `${app}-${res}-${stg}`;
}

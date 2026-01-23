export class AppError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AppError";
    }
}

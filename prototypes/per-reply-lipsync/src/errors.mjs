export class PrototypeError extends Error {
  constructor(code, message, { cause, status = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PrototypeError";
    this.code = code;
    this.status = status;
  }
}

export function asPrototypeError(error, fallbackCode, fallbackMessage) {
  if (error instanceof PrototypeError) return error;
  return new PrototypeError(fallbackCode, fallbackMessage, { cause: error });
}

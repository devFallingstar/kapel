export interface ProviderErrorInit {
  readonly provider: string;
  readonly status: number;
  readonly message: string;
  readonly body?: string | undefined;
}

/** Raised when a provider returns a non-2xx response or an in-stream error. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body?: string | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = "ProviderError";
    this.provider = init.provider;
    this.status = init.status;
    this.body = init.body;
  }
}

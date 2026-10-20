import type { ScopeId } from '../auth/scopes';

export class AzureDevOpsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly typeKey?: string,
  ) {
    super(message);
    this.name = 'AzureDevOpsError';
  }
}

/** The PAT is valid but does not grant a scope the request needs. */
export class AccessDeniedError extends AzureDevOpsError {
  constructor(
    message: string,
    status: number,
    url: string,
    readonly scope: ScopeId | undefined,
  ) {
    super(message, status, url);
    this.name = 'AccessDeniedError';
  }
}

/** The PAT itself was rejected: expired, revoked, or not valid for this organization. */
export class AuthenticationError extends AzureDevOpsError {
  constructor(message: string, status: number, url: string) {
    super(message, status, url);
    this.name = 'AuthenticationError';
  }
}

export class NotSignedInError extends Error {
  constructor() {
    super('Sign in to Azure DevOps first.');
    this.name = 'NotSignedInError';
  }
}

export class NoProjectError extends Error {
  constructor() {
    super('Select an Azure DevOps project first.');
    this.name = 'NoProjectError';
  }
}

/** Pulls the human readable message out of an Azure DevOps error payload. */
export function extractErrorMessage(body: string): { message?: string; typeKey?: string } {
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as { message?: string; typeKey?: string; value?: { Message?: string } };
    return { message: parsed.message ?? parsed.value?.Message, typeKey: parsed.typeKey };
  } catch {
    const title = /<title>([^<]*)<\/title>/i.exec(body);
    return { message: title ? title[1].trim() : undefined };
  }
}

export type DomainErrorData = {
  status: string;
  [key: string]: unknown;
};

export class DomainError extends Error {
  constructor(
    readonly data: DomainErrorData,
    message: string,
  ) {
    super(message);
  }
}

export function versionConflict(expectedVersion: number, currentVersion: number): DomainError {
  return new DomainError(
    { status: "conflict", conflict_type: "plan_version", expected_version: expectedVersion, current_version: currentVersion },
    `Inventory plan version changed: expected ${expectedVersion}, current ${currentVersion}`,
  );
}

export function notFound(
  entityType: string,
  supplied: Record<string, unknown>,
  suggestedTool: string,
  message: string,
): DomainError {
  return new DomainError(
    { status: "not_found", entity_type: entityType, ...supplied, suggested_tool: suggestedTool },
    message,
  );
}

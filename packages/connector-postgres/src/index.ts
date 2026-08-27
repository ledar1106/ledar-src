export { connectReadOnly, proveCannotWrite } from './connect.js';
export type { ConnectOptions } from './connect.js';

export { inspectPrivileges, disclosureFor } from './privileges.js';
export type {
  PrivilegeVerdict,
  SessionPrivileges,
  WritableTable,
} from './privileges.js';

export { buildReadOnlyRoleSql, buildRevokeWriteSql } from './role-sql.js';
export type { RoleSqlOptions } from './role-sql.js';

export { readSchemaGraph, probeEmptyTables } from './schema.js';
export type {
  SchemaGraph,
  Constraint,
  ConstraintKind,
  IndexInfo,
  TableRef,
  ColumnInfo,
  TableSize,
} from './schema.js';

export { QueryBudget, DEFAULT_LIMITS } from './budget.js';
export type { BudgetLimits, BudgetSpend, Denial } from './budget.js';

export { readScope, describeScope, buildRevokeSql } from './scope.js';
export type { ScopeReport } from './scope.js';

export {
  numericLiteral,
  tableSampleClause,
  quoteIdent,
  qualified,
  quoteLiteral,
  tryQualified,
} from './identifiers.js';

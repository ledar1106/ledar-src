export {
  runImplicitForeignKeys,
  findCandidates,
  semanticQuestionFor,
  IMPLICIT_FK_RULE,
  LAYER_B_RULE_VERSION,
} from './implicit-fk.js';
export type {
  ImplicitFkCandidate,
  LayerBOutcome,
  NotExaminedCause,
  NotExaminedTarget,
  RuledOutCause,
  RuledOutTarget,
} from './implicit-fk.js';

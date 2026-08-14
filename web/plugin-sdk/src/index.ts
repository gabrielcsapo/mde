/** Incremented only when a plugin contract becomes incompatible. */
export const MDE_PLUGIN_API_VERSION = 1 as const;

export type PluginCapabilityName =
  | 'document' | 'selection' | 'semantics' | 'state' | 'commands'
  | 'presentations' | 'decorations' | 'tasks' | 'input-rules'
  | 'transfers' | 'resources';

export interface PluginRequirement {
  apiVersion?: number;
  capabilities?: readonly PluginCapabilityName[];
}

export class PluginCompatibilityError extends Error {
  constructor(readonly plugin: string, readonly missing: readonly string[]) {
    super(`Plugin "${plugin}" is incompatible: missing ${missing.join(', ')}`);
    this.name = 'PluginCompatibilityError';
  }
}

export function assertPluginRequirements(
  plugin: string,
  requirement: PluginRequirement | undefined,
  capabilities: ReadonlySet<PluginCapabilityName>,
  apiVersion = MDE_PLUGIN_API_VERSION,
): void {
  if (!requirement) return;
  const missing: string[] = [];
  if (requirement.apiVersion != null && requirement.apiVersion !== apiVersion) {
    missing.push(`api@${requirement.apiVersion} (host is ${apiVersion})`);
  }
  for (const capability of requirement.capabilities ?? []) {
    if (!capabilities.has(capability)) missing.push(capability);
  }
  if (missing.length) throw new PluginCompatibilityError(plugin, missing);
}

export interface PluginRange { start: number; end: number }
export interface PluginTextEdit extends PluginRange { text: string }
export interface PluginTransactionMetadata {
  label?: string;
  origin?: string;
}
export interface PluginTransaction {
  edits: readonly PluginTextEdit[];
  selection?: PluginRange | null;
  metadata?: PluginTransactionMetadata;
}
export interface PluginTransactionResult {
  beforeLength: number;
  afterLength: number;
  changedRange: PluginRange | null;
}

export interface PluginDocumentCapability {
  readonly markdown: string;
  readonly length: number;
  slice(range: PluginRange): string;
  transact(transaction: PluginTransaction): PluginTransactionResult;
}
export interface PluginSelectionCapability {
  readonly range: PluginRange | null;
  set(range: PluginRange | null): void;
}

export interface PluginSemanticNode extends PluginRange {
  role: string;
  payload: string | null;
  source: string;
  layer: number;
}
export interface PluginSemanticQuery {
  roles?: readonly string[];
  range?: PluginRange;
  at?: number;
  intersects?: boolean;
}
export interface PluginSemanticsCapability {
  query(query?: PluginSemanticQuery): PluginSemanticNode[];
  at(position: number, roles?: readonly string[]): PluginSemanticNode[];
}

export interface PluginStateStore {
  read(plugin: string, key: string): unknown | Promise<unknown>;
  write(plugin: string, key: string, value: unknown): void | Promise<void>;
  delete(plugin: string, key: string): void | Promise<void>;
}
export interface PluginStateCapability {
  get<T>(key: string, fallback: T): T;
  load<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginOwnedHandle { unregister(): void }
export interface PluginInputRuleRequest {
  inputType: string;
  data: string | null;
  selection: PluginRange | null;
  markdown: string;
}
export interface PluginInputRule {
  priority?: number;
  match(request: PluginInputRuleRequest): boolean;
  apply(request: PluginInputRuleRequest): PluginTransaction | null;
}
export interface PluginInputRulesCapability {
  register(name: string, rule: PluginInputRule): PluginOwnedHandle;
}

export type PluginTransferKind = 'paste' | 'drop' | 'host';
export interface PluginTransferPayload<T = unknown> {
  kind: PluginTransferKind;
  value: T;
  position?: number;
  nativeEvent?: Event;
}
export interface PluginTransferHandler<T = unknown> {
  priority?: number;
  accepts(payload: PluginTransferPayload): payload is PluginTransferPayload<T>;
  handle(payload: PluginTransferPayload<T>): boolean | Promise<boolean>;
}
export interface PluginTransfersCapability {
  register<T>(name: string, handler: PluginTransferHandler<T>): PluginOwnedHandle;
  route(payload: PluginTransferPayload): Promise<boolean>;
}

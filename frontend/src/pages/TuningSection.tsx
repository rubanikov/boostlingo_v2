/**
 * The tuning panel's knob primitives (ticket 02), split out of
 * `TuningPanel.tsx` because that file passed the ~400-line threshold the
 * wireframe (§2) set for doing so.
 *
 * Every later ticket adds its rows with these, so the three treatments they
 * encode are built exactly once here:
 *
 *  - **pending** — an amber inset left rule on the row, an amber dot before
 *    the control, and a `was: <previous value>` badge. Three layers because
 *    the rule gets clipped inside nested bordered cards and colour alone is
 *    never a sufficient signal (wireframe §5, §9).
 *  - **disabled** — genuinely `disabled`, with the reason in *visible* text.
 *    A `title` on a disabled control is unreachable by keyboard (§9).
 *  - **connection-level** — a `reconnects` chip on the row, which is the same
 *    fact that flips the Apply label to `Apply (reconnects STT)`.
 *
 * Segmented controls are real radio inputs inside a `role="radiogroup"`
 * (DaisyUI's `join-item btn` radio pattern), not buttons: keyboard arrow
 * navigation and the "one of N" announcement come for free.
 */
import type { ReactNode } from 'react';

/** Per-knob display state, computed once by the panel from the pending diff. */
export interface KnobState {
  pending: boolean;
  /** The previously applied value, formatted. Drives the `was:` badge. */
  was?: string;
  /** Deepgram connection-level: applying this reopens the STT socket. */
  reconnects?: boolean;
  disabled?: boolean;
}

export interface KnobRowProps {
  /** The control's `id`, so the visible label is a real `<label for>`. */
  htmlFor?: string;
  label: ReactNode;
  knob?: KnobState;
  /** The provider's own field name, muted mono beside the label. */
  wireField?: string;
  /** Right-aligned value readout — a `range` alone can't say "−45 dBFS". */
  readout?: ReactNode;
  /** Extra chips on the label line (status badges, mode scoping). */
  badges?: ReactNode;
  /** Visible explanation under the control. Never a `title` alone. */
  hint?: ReactNode;
  /** Label and control side by side (toggles) rather than stacked. */
  inline?: boolean;
  children: ReactNode;
}

export function KnobRow({
  htmlFor,
  label,
  knob,
  wireField,
  readout,
  badges,
  hint,
  inline = false,
  children,
}: KnobRowProps) {
  const pendingClass = knob?.pending ? 'tuning-pending pl-2' : '';
  const labelClass = `text-[11px] text-base-content/60 ${inline ? 'flex-1' : ''}`;
  // A radiogroup has no single control to point a `<label for>` at — its
  // accessible name is the group's `aria-label` — so the visible text is a
  // span there rather than a label bound to nothing.
  const labelNode = htmlFor ? (
    <label htmlFor={htmlFor} className={`${labelClass} cursor-pointer`}>
      {label}
    </label>
  ) : (
    <span className={labelClass}>{label}</span>
  );

  return (
    <div className={`py-1 rounded ${pendingClass}`} data-pending={knob?.pending ? 'true' : undefined}>
      <div className="flex items-center gap-1.5">
        {knob?.pending ? (
          <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" title="Changed, not applied" />
        ) : null}
        {inline ? children : labelNode}
        {inline ? labelNode : null}
        {readout ? <span className="ml-auto font-mono text-[11px] text-base-content/60">{readout}</span> : null}
        {badges}
        {knob?.was !== undefined ? (
          <span className="badge badge-warning badge-soft badge-xs">was: {knob.was}</span>
        ) : null}
        {knob?.reconnects ? <span className="badge badge-ghost badge-xs">reconnects</span> : null}
        {wireField ? <span className="text-[11px] text-base-content/40 font-mono">{wireField}</span> : null}
      </div>
      {inline ? null : children}
      {hint ? <p className="text-[11px] text-base-content/50 pt-0.5">{hint}</p> : null}
    </div>
  );
}

export interface NumericKnobProps extends Omit<KnobRowProps, 'children' | 'htmlFor' | 'readout'> {
  id: string;
  testId: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  /** How the value reads beside the slider (units, decimals). */
  format?: (value: number) => string;
}

/** A slider is always paired with a numeric readout — wireframe §10. */
export function RangeKnob({ id, testId, value, min, max, step, onChange, format, ...row }: NumericKnobProps) {
  return (
    <KnobRow {...row} htmlFor={id} readout={format ? format(value) : String(value)}>
      <input
        type="range"
        id={id}
        data-testid={testId}
        className="range range-xs range-primary w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={row.knob?.disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </KnobRow>
  );
}

export function NumberKnob({ id, testId, value, min, max, step, onChange, ...row }: NumericKnobProps) {
  return (
    <KnobRow {...row} htmlFor={id}>
      <input
        type="number"
        id={id}
        data-testid={testId}
        className="input input-xs w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={row.knob?.disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </KnobRow>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  /** The accessible name of the option; also its visible text. */
  label: string;
  disabled?: boolean;
  title?: string;
  testId: string;
}

export interface SegmentedKnobProps<T extends string> extends Omit<KnobRowProps, 'children' | 'htmlFor'> {
  /** Radio-group name; must be unique per rendered group. */
  name: string;
  /** Names the group for a screen reader — the knob, not the option. */
  groupLabel: string;
  options: SegmentedOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
}

export function SegmentedKnob<T extends string>({
  name,
  groupLabel,
  options,
  value,
  onChange,
  ...row
}: SegmentedKnobProps<T>) {
  return (
    <KnobRow {...row}>
      <div className="join w-full" role="radiogroup" aria-label={groupLabel}>
        {options.map((option) => (
          <input
            key={option.value}
            type="radio"
            name={name}
            className={`join-item btn btn-xs flex-1 ${option.disabled ? 'btn-disabled' : ''}`}
            aria-label={option.label}
            title={option.title}
            data-testid={option.testId}
            value={option.value}
            checked={value === option.value}
            disabled={row.knob?.disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
        ))}
      </div>
    </KnobRow>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectKnobProps extends Omit<KnobRowProps, 'children' | 'htmlFor'> {
  id: string;
  testId: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * A curated picker. Never a free-text input: the server validates model and
 * voice ids against its own allow-list and 400s anything outside it, so
 * letting someone type here would only ever produce a rejected session
 * (story AC 5.6).
 */
export function SelectKnob({ id, testId, options, value, onChange, ...row }: SelectKnobProps) {
  return (
    <KnobRow {...row} htmlFor={id}>
      <select
        id={id}
        data-testid={testId}
        className="select select-xs w-full"
        value={value}
        disabled={row.knob?.disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </KnobRow>
  );
}

/**
 * The "Provider default" checkbox. Checked means the key is **omitted from
 * the outbound payload entirely** — which is not the same as sending the
 * provider's default value, and is why this is a checkbox beside the input
 * rather than one more value in the input's range (wireframe §3 rule 1).
 */
export function ProviderDefaultKnob({
  id,
  testId,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  testId: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="label cursor-pointer gap-1 py-0" htmlFor={id}>
      <input
        type="checkbox"
        id={id}
        data-testid={testId}
        className="checkbox checkbox-xs"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="label-text text-[10px]">Provider default</span>
    </label>
  );
}

/**
 * One accordion section. Native `<details>/<summary>` rather than DaisyUI's
 * checkbox-collapse: keyboard-operable and announced with zero JS, and the
 * open/closed state stays in the DOM where a test can read it.
 */
export function TuningSection({
  testId,
  title,
  summaryBadges,
  defaultOpen = false,
  children,
}: {
  testId: string;
  title: string;
  summaryBadges?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="collapse collapse-arrow bg-base-200 rounded-box" open={defaultOpen} data-testid={testId}>
      <summary className="collapse-title text-sm font-medium min-h-0 py-2">
        <span>{title}</span>
        {summaryBadges}
      </summary>
      <div className="collapse-content text-sm space-y-2">{children}</div>
    </details>
  );
}

/**
 * A denoise-chain stage: toggle + name + where it runs + its status, with its
 * parameters indented underneath. Every stage in the pipeline gets one of
 * these whether or not it can run here — the panel is the complete inventory
 * of processing steps (locked decision 11), so an unavailable stage is shown
 * disabled with the reason rather than hidden.
 */
export function DenoiseStageCard({
  id,
  testId,
  name,
  runsIn,
  enabled,
  onToggle,
  knob,
  status,
  hint,
  dashed = false,
  children,
}: {
  id: string;
  testId: string;
  name: string;
  runsIn?: 'browser' | 'server' | 'provider';
  enabled: boolean;
  onToggle?: (on: boolean) => void;
  knob?: KnobState;
  status?: ReactNode;
  hint?: ReactNode;
  dashed?: boolean;
  children?: ReactNode;
}) {
  const disabled = knob?.disabled ?? false;
  return (
    <div
      className={`rounded-box border border-base-300 p-2 space-y-2 ${dashed ? 'border-dashed' : ''} ${
        knob?.pending ? 'tuning-pending' : ''
      }`}
    >
      <div className={`flex items-center gap-2 ${disabled ? 'opacity-60' : ''}`}>
        {knob?.pending ? (
          <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" title="Changed, not applied" />
        ) : null}
        <input
          type="checkbox"
          id={id}
          data-testid={testId}
          className={`toggle toggle-xs ${disabled ? '' : 'toggle-primary'}`}
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onToggle?.(event.target.checked)}
        />
        <label htmlFor={id} className={`font-medium flex-1 ${disabled ? '' : 'cursor-pointer'}`}>
          {name}
        </label>
        {runsIn ? <span className="badge badge-ghost badge-xs">runs in: {runsIn}</span> : null}
        {status}
        {knob?.was !== undefined ? (
          <span className="badge badge-warning badge-soft badge-xs">was: {knob.was}</span>
        ) : null}
      </div>
      {hint ? <p className="text-[11px] text-base-content/50 pl-6">{hint}</p> : null}
      {children ? <div className={`pl-6 space-y-1 ${disabled ? 'opacity-40' : ''}`}>{children}</div> : null}
    </div>
  );
}

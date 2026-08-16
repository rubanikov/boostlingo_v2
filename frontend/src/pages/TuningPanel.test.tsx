import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeFetchRouter, defaultCapabilitiesBody, jsonResponse } from '../test/mockRealtimeApis';
import type { ApplyProgress, ConnectionStatus } from './sessionHandle';
import { TuningPanel } from './TuningPanel';
import { DEFAULT_TUNING_CONFIG, type ModeTuningConfig, type TuningMode } from './tuningConfig';
import { useTuningConfig, type ApplyResult, type ApplyTuning } from './useTuningConfig';

/**
 * The panel is presentational: it takes the controller `WorkbenchPage` owns.
 * This harness is the same wiring the page does, so the tests exercise the
 * real hook rather than a hand-made state object that could drift from it.
 */
function Harness({
  initialMode = 'cascade',
  connectionStatus = 'connected',
  applyTuning,
  applyProgress,
  appliedFingerprint,
  onClose = () => {},
}: {
  initialMode?: TuningMode;
  connectionStatus?: ConnectionStatus;
  applyTuning?: ApplyTuning;
  applyProgress?: ApplyProgress | null;
  appliedFingerprint?: string | null;
  onClose?: () => void;
}) {
  const [mode, setMode] = useState<TuningMode>(initialMode);
  const tuning = useTuningConfig(mode);
  return (
    <>
      <button type="button" onClick={() => setMode(mode === 'cascade' ? 'realtime' : 'cascade')}>
        switch mode
      </button>
      <TuningPanel
        mode={mode}
        tuning={tuning}
        connectionStatus={connectionStatus}
        onClose={onClose}
        appliedFingerprint={appliedFingerprint}
        applyTuning={applyTuning}
        applyProgress={applyProgress}
      />
    </>
  );
}

async function renderPanel(props: Parameters<typeof Harness>[0] = {}) {
  const user = userEvent.setup();
  const rendered = render(<Harness {...props} />);
  await screen.findByTestId('tuning-section-denoise');
  return Object.assign(user, {
    /** Re-renders the panel with different props — the page changing underneath it. */
    update: (next: Parameters<typeof Harness>[0]) => rendered.rerender(<Harness {...props} {...next} />),
  });
}

/** A transport that accepts every apply, so a test can read what it was sent. */
function acceptingTransport() {
  return vi.fn(
    async (_config: ModeTuningConfig): Promise<ApplyResult> => ({
      ok: true,
      fingerprint: 'cfg:00000000',
      reconnectedStt: false,
      deferred: false,
    }),
  );
}

/** The realtime half of the last document handed to the transport. */
async function realtimeBlockOf(applyTuning: ReturnType<typeof acceptingTransport>) {
  await waitFor(() => expect(applyTuning.mock.calls.length).toBeGreaterThan(0));
  const config = applyTuning.mock.calls.at(-1)?.[0];
  if (!config || config.mode !== 'realtime') throw new Error('expected the realtime projection');
  return config.realtime;
}

/** The cascade half of the last document handed to the transport. */
async function cascadeBlockOf(applyTuning: ReturnType<typeof acceptingTransport>) {
  await waitFor(() => expect(applyTuning.mock.calls.length).toBeGreaterThan(0));
  const config = applyTuning.mock.calls.at(-1)?.[0];
  if (!config || config.mode !== 'cascade') throw new Error('expected the cascade projection');
  return config.cascade;
}

function capabilitiesWith(stages: Record<string, unknown>) {
  const body = defaultCapabilitiesBody();
  return createRealtimeFetchRouter({
    capabilitiesResponse: jsonResponse({ ...body, stages: { ...body.stages, ...stages } }),
  });
}

describe('TuningPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createRealtimeFetchRouter());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('section skeleton (S3, S14)', () => {
    it('renders one section per processing step, in signal order, for Cascade', async () => {
      await renderPanel();

      // Scoped to the section stack: the header's preset `<optgroup>`s are
      // also `role="group"` (ticket 03).
      const sections = within(screen.getByTestId('tuning-sections')).getAllByRole('group');
      expect(sections.map((section) => section.getAttribute('data-testid'))).toEqual([
        'tuning-section-microphone',
        'tuning-section-denoise',
        'tuning-section-turn',
        'tuning-section-segmentation',
        'tuning-section-transcript-check',
        'tuning-section-models',
      ]);
      expect(within(sections[2]).getByText('Endpointing')).toBeInTheDocument();
    });

    it('renders only the active mode\'s sections: Realtime has no Segmentation section and titles turn detection differently', async () => {
      const user = await renderPanel();

      expect(screen.getByTestId('tuning-section-segmentation')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-model-deepgram')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'switch mode' }));

      expect(screen.queryByTestId('tuning-section-segmentation')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('tuning-section-turn')).getByText('Turn detection')).toBeInTheDocument();
      // Cascade-only pickers are gone, Realtime's are in their place.
      expect(screen.queryByTestId('tuning-model-deepgram')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-model-realtime')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-voice-realtime')).toBeInTheDocument();
    });

    it('carries the mode in the header badge and switches it with the tab', async () => {
      const user = await renderPanel();
      const header = screen.getByTestId('tuning-panel');

      expect(within(header).getByText('Cascade')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      expect(within(header).getByText('Realtime')).toBeInTheDocument();
    });

    it('never offers Wave-U-Net (story AC 5.5 — verified by absence)', async () => {
      await renderPanel();
      expect(screen.queryByText(/wave-?u-?net/i)).not.toBeInTheDocument();
    });
  });

  /**
   * The Microphone section (ticket 11): three browser constraints that live in
   * the shared `client` block, so the same rows serve both modes. Nothing here
   * can change a running capture, which is what the footnote says and why no
   * row carries a `reconnects` chip.
   */
  describe('microphone constraints (S21, AC 3.1)', () => {
    const MIC_TOGGLES = ['tuning-mic-ec', 'tuning-mic-ns', 'tuning-mic-agc'] as const;

    function micRow(testId: string): HTMLElement {
      const row = screen.getByTestId(testId).closest('div.py-1');
      if (!row) throw new Error(`${testId} is not inside a knob row`);
      return row as HTMLElement;
    }

    /** The shared client block of the last document handed to the transport. */
    async function clientBlockOf(applyTuning: ReturnType<typeof acceptingTransport>) {
      await waitFor(() => expect(applyTuning.mock.calls.length).toBeGreaterThan(0));
      const config = applyTuning.mock.calls.at(-1)?.[0];
      if (!config) throw new Error('expected a config to have been applied');
      return config.client;
    }

    it('renders the three toggles, on by the server defaults, with the wire field beside each', async () => {
      await renderPanel();

      for (const testId of MIC_TOGGLES) {
        expect(screen.getByTestId(testId)).toBeChecked();
      }
      expect(screen.getByTestId('tuning-mic-ec')).toHaveAccessibleName('Echo cancellation');
      expect(screen.getByTestId('tuning-mic-ns')).toHaveAccessibleName('Noise suppression');
      expect(screen.getByTestId('tuning-mic-agc')).toHaveAccessibleName('Auto gain control');
      expect(within(micRow('tuning-mic-ec')).getByText('echoCancellation')).toBeInTheDocument();
      expect(within(micRow('tuning-mic-ns')).getByText('noiseSuppression')).toBeInTheDocument();
      expect(within(micRow('tuning-mic-agc')).getByText('autoGainControl')).toBeInTheDocument();
    });

    it('binds each toggle to its own client.microphone key', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });

      await user.click(screen.getByTestId('tuning-mic-ec'));
      await user.click(screen.getByTestId('tuning-mic-agc'));
      await user.click(screen.getByTestId('tuning-apply'));

      expect((await clientBlockOf(applyTuning)).microphone).toEqual({
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      });
    });

    it('carries the same shared toggles in Realtime, not a Cascade-only section', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });

      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      for (const testId of MIC_TOGGLES) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      }

      await user.click(screen.getByTestId('tuning-mic-ns'));
      await user.click(screen.getByTestId('tuning-apply'));

      expect((await clientBlockOf(applyTuning)).microphone).toEqual({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
      });
    });

    it('says the change lands at the next connect, and never claims a reconnect', async () => {
      const user = await renderPanel({ applyTuning: acceptingTransport() });

      expect(
        within(screen.getByTestId('tuning-section-microphone')).getByText(
          'Applied at getUserMedia time — takes effect on the next connect.',
        ),
      ).toBeInTheDocument();

      await user.click(screen.getByTestId('tuning-mic-ec'));

      // Pending, yes — but a `getUserMedia` constraint costs no connection, so
      // neither the row nor the Apply label may suggest one.
      expect(micRow('tuning-mic-ec')).toHaveAttribute('data-pending', 'true');
      expect(within(screen.getByTestId('tuning-section-microphone')).queryByText('reconnects')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent(/^Apply$/);
      expect(screen.getByTestId('tuning-status')).toHaveTextContent('1 changes pending');
    });

    it('no longer shows the empty-section placeholder it shipped with', async () => {
      await renderPanel();

      expect(
        within(screen.getByTestId('tuning-section-microphone')).queryByText(/no adjustable settings/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('server defaults and curated pickers (S13, S31)', () => {
    it('displays the values the server published, not blanks', async () => {
      const defaults = structuredClone(DEFAULT_TUNING_CONFIG);
      defaults.cascade.translationModel = 'gpt-4.1-mini';
      defaults.cascade.transcriptCheck.mode = 'flag';
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: jsonResponse({ ...defaultCapabilitiesBody(), defaults }),
        }),
      );
      await renderPanel();

      await waitFor(() => expect(screen.getByTestId('tuning-model-translation')).toHaveValue('gpt-4.1-mini'));
      expect(screen.getByTestId('tuning-model-deepgram')).toHaveValue('nova-3');
      expect(screen.getByTestId('tuning-transcript-check-flag')).toBeChecked();
    });

    it('renders every model/voice picker as a fixed list with no free-text entry', async () => {
      const user = await renderPanel();
      const panel = screen.getByTestId('tuning-panel');

      for (const testId of [
        'tuning-model-deepgram',
        'tuning-model-translation',
        'tuning-voice-a',
        'tuning-voice-b',
        'tuning-segmentation-model',
        'tuning-transcript-check-model',
      ]) {
        const picker = screen.getByTestId(testId);
        expect(picker.tagName).toBe('SELECT');
        expect(within(picker).getAllByRole('option').length).toBeGreaterThan(0);
      }
      expect(screen.getByTestId('tuning-model-deepgram')).toHaveAccessibleName('Deepgram model');
      expect(panel.querySelectorAll('input[type="text"]')).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      for (const testId of ['tuning-model-realtime', 'tuning-voice-realtime']) {
        expect(screen.getByTestId(testId).tagName).toBe('SELECT');
      }
      expect(screen.getByTestId('tuning-panel').querySelectorAll('input[type="text"]')).toHaveLength(0);
    });

    it('populates the pickers from the server allow-lists rather than a hardcoded list', async () => {
      const body = defaultCapabilitiesBody();
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: jsonResponse({
            ...body,
            allowLists: { ...body.allowLists, deepgramModels: ['nova-3', 'nova-2', 'nova-3-general'] },
          }),
        }),
      );
      await renderPanel();

      await waitFor(() =>
        expect(
          within(screen.getByTestId('tuning-model-deepgram'))
            .getAllByRole('option')
            .map((option) => option.textContent),
        ).toEqual(['nova-3', 'nova-2', 'nova-3-general']),
      );
    });
  });

  describe('endpointing and segmentation, Cascade (ticket 06)', () => {
    it('renders the three Deepgram endpointing rows, showing the applied values', async () => {
      await renderPanel();
      const section = screen.getByTestId('tuning-section-turn');

      expect(within(section).getByTestId('tuning-dg-endpointing')).toHaveValue(500);
      expect(within(section).getByTestId('tuning-dg-utterance-end')).toHaveValue(3000);
      expect(within(section).getByTestId('tuning-dg-diarize')).toBeChecked();
      expect(screen.getByTestId('tuning-dg-endpointing')).toHaveAccessibleName('Endpointing (ms)');
      expect(screen.getByTestId('tuning-dg-diarize')).toHaveAccessibleName('Diarize');
    });

    it('leaves the endpointing rows out of Realtime, where the section is turn detection instead', async () => {
      const user = await renderPanel();
      await user.click(screen.getByRole('button', { name: 'switch mode' }));

      expect(screen.queryByTestId('tuning-dg-endpointing')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tuning-dg-diarize')).not.toBeInTheDocument();
    });

    it('marks an endpointing edit pending, chips the row and the section as reconnecting STT, and flips the Apply label', async () => {
      const user = await renderPanel();
      const section = screen.getByTestId('tuning-section-turn');
      // The chip is a claim about a change that is about to be applied, so it
      // is not there before one is made.
      expect(within(section).queryByText('reconnects STT')).not.toBeInTheDocument();

      const endpointing = screen.getByTestId('tuning-dg-endpointing');
      await user.clear(endpointing);
      await user.type(endpointing, '300');

      expect(endpointing).toHaveValue(300);
      const row = endpointing.closest('.tuning-pending');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText('was: 500')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByText('reconnects')).toBeInTheDocument();
      expect(within(section).getByText('reconnects STT')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply (reconnects STT)');
    });

    it('binds utterance end and the diarize toggle to the draft, both as connection-level changes', async () => {
      const user = await renderPanel();

      const utteranceEnd = screen.getByTestId('tuning-dg-utterance-end');
      await user.clear(utteranceEnd);
      await user.type(utteranceEnd, '2000');
      await user.click(screen.getByTestId('tuning-dg-diarize'));

      expect(utteranceEnd).toHaveValue(2000);
      expect(screen.getByTestId('tuning-dg-diarize')).not.toBeChecked();
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        '2 changes pending · 1 reopens the Deepgram connection',
      );
      expect(within(screen.getByTestId('tuning-section-turn')).getByText('reconnects STT')).toBeInTheDocument();
    });

    it('offers the segmentation mode as a two-option join beside the model picker, with hybrid applied', async () => {
      await renderPanel();
      const group = screen.getByRole('radiogroup', { name: 'Segmentation mode' });

      expect(within(group).getAllByRole('radio')).toHaveLength(2);
      expect(screen.getByTestId('tuning-segmentation-mode-hybrid')).toBeChecked();
      expect(screen.getByTestId('tuning-segmentation-mode-llm')).not.toBeChecked();
      expect(screen.getByTestId('tuning-segmentation-model')).toBeInTheDocument();
    });

    it('applies a segmentation mode change without claiming a reconnect (AC 1.6)', async () => {
      const user = await renderPanel();

      await user.click(screen.getByTestId('tuning-segmentation-mode-llm'));

      expect(screen.getByTestId('tuning-segmentation-mode-llm')).toBeChecked();
      const row = screen.getByTestId('tuning-segmentation-mode-llm').closest('.tuning-pending');
      expect(within(row as HTMLElement).getByText('was: hybrid')).toBeInTheDocument();
      expect(within(row as HTMLElement).queryByText('reconnects')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-status')).toHaveTextContent('1 changes pending');
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent(/^Apply$/);
      // The collapsed summary follows the draft, so it says what it is set to.
      expect(
        within(screen.getByTestId('tuning-section-segmentation')).getByText('llm-priority'),
      ).toBeInTheDocument();
    });

    it('sends the whole projected Cascade document to the transport on Apply', async () => {
      const applyTuning = vi.fn(
        async (_config: ModeTuningConfig): Promise<ApplyResult> => ({
          ok: true,
          fingerprint: 'cfg:1234abcd',
          reconnectedStt: true,
          deferred: false,
        }),
      );
      const user = await renderPanel({ applyTuning });

      await user.click(screen.getByTestId('tuning-segmentation-mode-llm'));
      await user.click(screen.getByTestId('tuning-apply'));

      await waitFor(() => expect(applyTuning).toHaveBeenCalledTimes(1));
      const sent = applyTuning.mock.calls[0][0];
      expect(sent.mode).toBe('cascade');
      expect(sent).toMatchObject({ cascade: { segmentation: { mode: 'llm_priority' } } });
    });
  });

  describe('transcript check (S25)', () => {
    it('offers off/flag/correct in Cascade, all selectable', async () => {
      await renderPanel();

      for (const testId of ['tuning-transcript-check-off', 'tuning-transcript-check-flag', 'tuning-transcript-check-correct']) {
        expect(screen.getByTestId(testId)).toBeEnabled();
      }
      expect(screen.getByTestId('tuning-transcript-check-off')).toBeChecked();
    });

    it('renders correct as genuinely disabled in Realtime, with the reason in visible text', async () => {
      const user = await renderPanel();
      await user.click(screen.getByRole('button', { name: 'switch mode' }));

      expect(screen.getByTestId('tuning-transcript-check-off')).toBeEnabled();
      expect(screen.getByTestId('tuning-transcript-check-flag')).toBeEnabled();
      expect(screen.getByTestId('tuning-transcript-check-correct')).toBeDisabled();
      // Visible, not a `title` alone — a title on a disabled control is
      // unreachable by keyboard (wireframe §9).
      expect(screen.getByText('correct is unavailable: no seam in Realtime.')).toBeInTheDocument();
    });

    it('carries a Cascade correct choice into the projected document — the join is bound, not decorative', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });

      await user.click(screen.getByTestId('tuning-transcript-check-correct'));
      await user.click(screen.getByTestId('tuning-apply'));

      await waitFor(() => expect(applyTuning.mock.calls.length).toBeGreaterThan(0));
      const config = applyTuning.mock.calls.at(-1)?.[0];
      if (!config || config.mode !== 'cascade') throw new Error('expected the cascade projection');
      expect(config.cascade.transcriptCheck.mode).toBe('correct');
    });

    it('carries a Realtime flag choice into the Realtime half of the document', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning, initialMode: 'realtime' });

      await user.click(screen.getByTestId('tuning-transcript-check-flag'));
      await user.click(screen.getByTestId('tuning-apply'));

      expect((await realtimeBlockOf(applyTuning)).transcriptCheck.mode).toBe('flag');
    });
  });

  describe('denoise inventory (S30, F13, F14)', () => {
    it('always disables Demucs and denoiser (DNS64) and tags them benchmark only, in both modes', async () => {
      const user = await renderPanel();

      expect(screen.getByTestId('tuning-demucs-enabled')).toBeDisabled();
      expect(screen.getByTestId('tuning-dns-enabled')).toBeDisabled();
      expect(screen.getAllByText('benchmark only')).toHaveLength(2);

      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      expect(screen.getByTestId('tuning-demucs-enabled')).toBeDisabled();
      expect(screen.getByTestId('tuning-dns-enabled')).toBeDisabled();
    });

    it('shows the server stages as not installed, disabled, with the fix in visible text, when the server says so (F14)', async () => {
      await renderPanel();

      expect(screen.getByTestId('tuning-dfn-enabled')).toBeDisabled();
      expect(screen.getByTestId('tuning-dfn-attenuation-limit')).toBeDisabled();
      expect(screen.getByTestId('tuning-dfn-post-filter')).toBeDisabled();
      expect(screen.getByTestId('tuning-dfn-unavailable')).toHaveTextContent('not installed');
      expect(screen.getByText(/uv sync --extra denoise/)).toBeInTheDocument();
      expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeDisabled();
    });

    it('falls back to every server denoise row not installed when the capabilities request fails (F13)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' },
        }),
      );
      await renderPanel();

      expect(screen.getByTestId('tuning-dfn-enabled')).toBeDisabled();
      expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeDisabled();
      expect(screen.getAllByText('not installed')).toHaveLength(2);
      // The panel still shows the built-in defaults rather than blanks.
      expect(screen.getByTestId('tuning-model-deepgram')).toHaveValue('nova-3');
      warn.mockRestore();
    });

    it('enables a stage the server reports as installed', async () => {
      vi.stubGlobal('fetch', capabilitiesWith({ noisereduce: { installed: true, liveCapable: true } }));
      await renderPanel();

      await waitFor(() => expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeEnabled());
      expect(screen.getByTestId('tuning-noisereduce-prop-decrease')).toBeEnabled();
      expect(screen.getByTestId('tuning-dfn-enabled')).toBeDisabled(); // still not installed
    });

    it('distinguishes "installed but the weights failed to load" from "not installed"', async () => {
      vi.stubGlobal(
        'fetch',
        capabilitiesWith({
          deepfilternet: { installed: true, liveCapable: true, reason: 'model weights unavailable — see the server log.' },
        }),
      );
      await renderPanel();

      await waitFor(() =>
        expect(screen.getByTestId('tuning-dfn-unavailable')).toHaveTextContent('model weights unavailable'),
      );
      expect(screen.getByText('model weights unavailable — see the server log.')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-dfn-enabled')).toBeDisabled();
    });

    it('marks the server stages Cascade only in Realtime, and OpenAI noise reduction Realtime only in Cascade', async () => {
      const user = await renderPanel();

      expect(screen.getByTestId('tuning-openai-noise-reduction-near')).toBeDisabled();
      expect(screen.getByTestId('tuning-openai-noise-reduction-default')).toBeDisabled();
      expect(screen.getAllByText('Realtime only').length).toBeGreaterThan(0);

      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      expect(screen.getByTestId('tuning-dfn-enabled')).toBeDisabled();
      expect(screen.getAllByText('Cascade only')).toHaveLength(2);
      expect(screen.getByTestId('tuning-openai-noise-reduction-default')).toBeEnabled();
    });

    it('greys the OpenAI noise-reduction row while Provider default is checked, and hands it over when unchecked', async () => {
      const user = await renderPanel({ initialMode: 'realtime' });

      // Checked = the key is omitted from the payload entirely, so there is no
      // value to edit — the row is genuinely disabled, not merely dimmed.
      expect(screen.getByTestId('tuning-openai-noise-reduction-default')).toBeChecked();
      expect(screen.getByTestId('tuning-openai-noise-reduction-near')).toBeDisabled();

      await user.click(screen.getByTestId('tuning-openai-noise-reduction-default'));

      expect(screen.getByTestId('tuning-openai-noise-reduction-near')).toBeEnabled();
      expect(screen.getByTestId('tuning-openai-noise-reduction-near')).toBeChecked();
      expect(screen.getByTestId('tuning-status')).toHaveTextContent('1 changes pending');

      await user.click(screen.getByTestId('tuning-openai-noise-reduction-off'));
      expect(screen.getByTestId('tuning-openai-noise-reduction-off')).toBeChecked();
    });
  });

  describe('turn detection, Realtime (ticket 04)', () => {
    const VAD_KNOBS = [
      'tuning-vad-threshold',
      'tuning-vad-prefix-padding',
      'tuning-vad-silence-duration',
      'tuning-vad-interrupt-response',
      'tuning-vad-eagerness',
    ];

    it('renders a row per OpenAI turn-detection knob in Realtime, each with its Provider default checkbox', async () => {
      await renderPanel({ initialMode: 'realtime' });

      expect(screen.getByTestId('tuning-vad-type-server')).toBeChecked();
      expect(screen.getByTestId('tuning-vad-type-semantic')).not.toBeChecked();
      for (const testId of VAD_KNOBS) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
        expect(screen.getByTestId(`${testId}-default`)).toBeChecked();
      }
      expect(
        screen.getByText(
          "A greyed field is unset — the key is omitted from the payload entirely, so the provider's own default applies.",
        ),
      ).toBeInTheDocument();
    });

    it('shows none of them in Cascade, whose turn-detection section is Deepgram endpointing', async () => {
      await renderPanel();

      expect(screen.queryByTestId('tuning-vad-type-server')).not.toBeInTheDocument();
      for (const testId of VAD_KNOBS) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
    });

    it('AC 1.3 — an unset knob is genuinely disabled; unchecking Provider default seeds it and marks it pending', async () => {
      const user = await renderPanel({ initialMode: 'realtime' });
      const before = screen.getByTestId('tuning-fingerprint-panel').textContent;

      expect(screen.getByTestId('tuning-vad-silence-duration')).toBeDisabled();

      await user.click(screen.getByTestId('tuning-vad-silence-duration-default'));

      const input = screen.getByTestId('tuning-vad-silence-duration');
      expect(input).toBeEnabled();
      // Seeded with OpenAI's own documented default, so the user nudges a real
      // number instead of typing into a blank.
      expect(input).toHaveValue(500);
      expect(screen.getByTestId('tuning-status')).toHaveTextContent('1 changes pending');
      // Only Apply moves the fingerprint.
      expect(screen.getByTestId('tuning-fingerprint-panel').textContent).toBe(before);

      await user.click(screen.getByTestId('tuning-apply'));
      expect(screen.getByTestId('tuning-fingerprint-panel').textContent).not.toBe(before);
    });

    it('AC 1.3 — re-checking Provider default removes the key again and restores the original fingerprint', async () => {
      const user = await renderPanel({ initialMode: 'realtime' });
      const before = screen.getByTestId('tuning-fingerprint-panel').textContent;

      await user.click(screen.getByTestId('tuning-vad-threshold-default'));
      await user.click(screen.getByTestId('tuning-apply'));
      const withThreshold = screen.getByTestId('tuning-fingerprint-panel').textContent;
      expect(withThreshold).not.toBe(before);

      await user.click(screen.getByTestId('tuning-vad-threshold-default'));
      await user.click(screen.getByTestId('tuning-apply'));

      // Omitting the key is not the same document as setting it to the
      // provider's default value — the hash has to come all the way back.
      expect(screen.getByTestId('tuning-fingerprint-panel').textContent).toBe(before);
      expect(screen.getByTestId('tuning-vad-threshold')).toBeDisabled();
    });

    it('greys eagerness while server_vad is selected, and the server_vad knobs once semantic_vad is', async () => {
      const user = await renderPanel({ initialMode: 'realtime' });

      // eagerness with server_vad is a 400 from the backend, so the panel will
      // not even let it off Provider default while server_vad is selected.
      expect(screen.getByTestId('tuning-vad-eagerness')).toBeDisabled();
      expect(screen.getByTestId('tuning-vad-eagerness-default')).toBeDisabled();
      expect(screen.getByText('semantic_vad only')).toBeInTheDocument();

      await user.click(screen.getByTestId('tuning-vad-threshold-default'));
      await user.click(screen.getByTestId('tuning-vad-interrupt-response-default'));
      expect(screen.getByTestId('tuning-vad-threshold')).toBeEnabled();
      expect(screen.getByTestId('tuning-vad-interrupt-response')).toBeEnabled();

      await user.click(screen.getByTestId('tuning-vad-type-semantic'));

      // "A greyed field omits the key" is the section's own promise, so the
      // server_vad-only keys go with the type rather than lingering in a
      // document that no longer sends them.
      expect(screen.getByTestId('tuning-vad-threshold')).toBeDisabled();
      expect(screen.getByTestId('tuning-vad-threshold-default')).toBeChecked();
      expect(screen.getByTestId('tuning-vad-prefix-padding')).toBeDisabled();
      expect(screen.getByTestId('tuning-vad-silence-duration')).toBeDisabled();
      // interrupt_response is valid on both types, so it survives the switch.
      expect(screen.getByTestId('tuning-vad-interrupt-response')).toBeEnabled();
      expect(screen.getByText('server_vad only')).toBeInTheDocument();

      await user.click(screen.getByTestId('tuning-vad-eagerness-default'));
      expect(screen.getByTestId('tuning-vad-eagerness')).toBeEnabled();
    });

    it('AC 1.2 — the applied document carries the knobs the panel set, and nothing it did not', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ initialMode: 'realtime', applyTuning });

      await user.click(screen.getByTestId('tuning-vad-type-semantic'));
      await user.click(screen.getByTestId('tuning-vad-eagerness-default'));
      await user.selectOptions(screen.getByTestId('tuning-vad-eagerness'), 'high');
      await user.click(screen.getByTestId('tuning-apply'));

      expect((await realtimeBlockOf(applyTuning)).turnDetection).toEqual({
        type: 'semantic_vad',
        eagerness: 'high',
      });
    });
  });

  describe('OpenAI noise reduction, three-state plus absent (AC 3.6)', () => {
    it('omits the key when Provider default is checked, and sends "off" as a real value when it is chosen', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ initialMode: 'realtime', applyTuning });

      async function applied() {
        await user.click(screen.getByTestId('tuning-apply'));
        return realtimeBlockOf(applyTuning);
      }

      // Unchecked → seeded with near_field, which is a value that gets sent.
      await user.click(screen.getByTestId('tuning-openai-noise-reduction-default'));
      expect(await applied()).toMatchObject({ noiseReduction: 'near_field' });

      // "off" is an explicit instruction to the provider, not an omission.
      await user.click(screen.getByTestId('tuning-openai-noise-reduction-off'));
      expect(await applied()).toMatchObject({ noiseReduction: 'off' });

      await user.click(screen.getByTestId('tuning-openai-noise-reduction-far'));
      expect(await applied()).toMatchObject({ noiseReduction: 'far_field' });

      // Back to Provider default: the key is gone, not set to anything.
      await user.click(screen.getByTestId('tuning-openai-noise-reduction-default'));
      expect(await applied()).not.toHaveProperty('noiseReduction');
    });
  });

  describe('RMS gate (ticket 12, AC 3.2)', () => {
    const GATE_TESTIDS = [
      'tuning-rms-enabled',
      'tuning-rms-threshold',
      'tuning-rms-hold',
      'tuning-rms-attack',
      'tuning-rms-release',
      'tuning-rms-attenuation',
      'tuning-rms-mute',
    ] as const;

    /** The gate block of the last document handed to the transport. */
    async function gateOf(applyTuning: ReturnType<typeof acceptingTransport>) {
      await waitFor(() => expect(applyTuning.mock.calls.length).toBeGreaterThan(0));
      const config = applyTuning.mock.calls.at(-1)?.[0];
      if (!config) throw new Error('expected a config to have been applied');
      return config.client.rmsGate;
    }

    it('renders every knob, on the server defaults, in both modes', async () => {
      const user = await renderPanel();

      for (const testId of GATE_TESTIDS) expect(screen.getByTestId(testId)).toBeInTheDocument();
      expect(screen.getByTestId('tuning-rms-enabled')).not.toBeChecked();
      expect(screen.getByTestId('tuning-rms-threshold')).toHaveValue('-45');
      expect(screen.getByTestId('tuning-rms-hold')).toHaveValue(200);
      expect(screen.getByTestId('tuning-rms-attack')).toHaveValue(5);
      expect(screen.getByTestId('tuning-rms-release')).toHaveValue(80);
      expect(screen.getByTestId('tuning-rms-attenuation')).toHaveValue('12');
      expect(screen.getByTestId('tuning-rms-mute')).not.toBeChecked();

      // Shared client block: the browser's gate knows nothing about which
      // transport is about to consume the track.
      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      for (const testId of GATE_TESTIDS) expect(screen.getByTestId(testId)).toBeInTheDocument();
    });

    it('is the first stage in the denoise chain and says it runs in the browser', async () => {
      await renderPanel();

      const denoise = screen.getByTestId('tuning-section-denoise');
      expect(within(denoise).getByText('RMS gate')).toBeInTheDocument();
      // Two browser-side stages since ticket 13: this one and RNNoise.
      expect(within(denoise).getAllByText('runs in: browser')).toHaveLength(2);

      // Signal order: ahead of every provider- and server-side stage.
      const toggles = within(denoise).getAllByRole('checkbox');
      expect(toggles[0]).toBe(screen.getByTestId('tuning-rms-enabled'));
    });

    it('binds each knob to its own client.rmsGate key', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });

      await user.click(screen.getByTestId('tuning-rms-enabled'));
      fireEvent.change(screen.getByTestId('tuning-rms-threshold'), { target: { value: '-30' } });
      fireEvent.change(screen.getByTestId('tuning-rms-hold'), { target: { value: '400' } });
      fireEvent.change(screen.getByTestId('tuning-rms-attack'), { target: { value: '12' } });
      fireEvent.change(screen.getByTestId('tuning-rms-release'), { target: { value: '150' } });
      fireEvent.change(screen.getByTestId('tuning-rms-attenuation'), { target: { value: '24' } });
      await user.click(screen.getByTestId('tuning-apply'));

      expect(await gateOf(applyTuning)).toEqual({
        enabled: true,
        thresholdDbfs: -30,
        holdMs: 400,
        attackMs: 12,
        releaseMs: 150,
        attenuationDb: 24,
        fullMute: false,
      });
    });

    it('reads the threshold and attenuation back in their own units', async () => {
      const user = await renderPanel();

      expect(within(screen.getByTestId('tuning-section-denoise')).getByText('-45 dBFS')).toBeInTheDocument();
      expect(within(screen.getByTestId('tuning-section-denoise')).getByText('12 dB')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('tuning-rms-threshold'), { target: { value: '-62' } });
      expect(within(screen.getByTestId('tuning-section-denoise')).getByText('-62 dBFS')).toBeInTheDocument();

      // Full mute is the far end of the same scale, so the readout says so and
      // the slider it overrides is genuinely disabled, not merely dimmed.
      await user.click(screen.getByTestId('tuning-rms-mute'));
      const attenuationRow = screen.getByTestId('tuning-rms-attenuation').closest('div.py-1');
      expect(within(attenuationRow as HTMLElement).getByText('mute')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-rms-attenuation')).toBeDisabled();
    });

    it('labels the attenuation scale from off to mute', async () => {
      await renderPanel();

      const denoise = screen.getByTestId('tuning-section-denoise');
      expect(within(denoise).getByText('0 dB (off)')).toBeInTheDocument();
      expect(within(denoise).getByText('60 dB')).toBeInTheDocument();
      expect(within(denoise).getByText('mute')).toBeInTheDocument();
    });

    it('carries Full mute into the applied document as its own key', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning, initialMode: 'realtime' });

      await user.click(screen.getByTestId('tuning-rms-mute'));
      await user.click(screen.getByTestId('tuning-apply'));

      expect(await gateOf(applyTuning)).toMatchObject({ fullMute: true, attenuationDb: 12 });
    });

    it('marks a changed gate knob pending without ever claiming a reconnect', async () => {
      await renderPanel({ applyTuning: acceptingTransport() });

      fireEvent.change(screen.getByTestId('tuning-rms-threshold'), { target: { value: '-30' } });

      const row = screen.getByTestId('tuning-rms-threshold').closest('div.py-1');
      expect(row).toHaveAttribute('data-pending', 'true');
      expect(within(row as HTMLElement).getByText('was: -45')).toBeInTheDocument();
      expect(within(row as HTMLElement).queryByText('reconnects')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent(/^Apply$/);
    });

    it('says which knobs apply live and which wait for the next connect', async () => {
      await renderPanel();

      expect(
        within(screen.getByTestId('tuning-section-denoise')).getByText(/apply live, without a reconnect/),
      ).toBeInTheDocument();
    });
  });

  describe('RNNoise (ticket 13, AC 3.4)', () => {
    /** The RNNoise block of the last document handed to the transport. */
    async function rnnoiseOf(applyTuning: ReturnType<typeof acceptingTransport>) {
      await waitFor(() => expect(applyTuning.mock.calls.length).toBeGreaterThan(0));
      const config = applyTuning.mock.calls.at(-1)?.[0];
      if (!config) throw new Error('expected a config to have been applied');
      return config.client.rnnoise;
    }

    it('renders the row on the server defaults, in both modes', async () => {
      const user = await renderPanel();

      expect(screen.getByTestId('tuning-rnnoise-enabled')).not.toBeChecked();
      expect(screen.getByTestId('tuning-rnnoise-voice-prob')).toHaveValue('0.5');

      // Shared client block, like the gate: the mic is denoised before either
      // transport ever sees it.
      await user.click(screen.getByRole('button', { name: 'switch mode' }));
      expect(screen.getByTestId('tuning-rnnoise-enabled')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-rnnoise-voice-prob')).toBeInTheDocument();
    });

    it('sits directly after the RMS gate in signal order and runs in the browser', async () => {
      await renderPanel();

      const denoise = screen.getByTestId('tuning-section-denoise');
      expect(within(denoise).getByText('RNNoise')).toBeInTheDocument();

      // The stage cards are siblings in the section, so "directly after" is a
      // DOM fact rather than an eyeballed one.
      const rms = screen.getByTestId('tuning-rms-enabled').closest('div.rounded-box');
      const card = screen.getByTestId('tuning-rnnoise-enabled').closest('div.rounded-box');
      expect(rms?.nextElementSibling).toBe(card);

      expect(within(card as HTMLElement).getByText('runs in: browser')).toBeInTheDocument();
    });

    it('binds the toggle to client.rnnoise.enabled and counts toward the section chip', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });

      await user.click(screen.getByTestId('tuning-rnnoise-enabled'));
      expect(within(screen.getByTestId('tuning-section-denoise')).getByText('1 on')).toBeInTheDocument();

      await user.click(screen.getByTestId('tuning-apply'));
      expect(await rnnoiseOf(applyTuning)).toMatchObject({ enabled: true });
    });

    it('marks the toggle pending without ever claiming a reconnect', async () => {
      await renderPanel({ applyTuning: acceptingTransport() });

      fireEvent.click(screen.getByTestId('tuning-rnnoise-enabled'));

      const card = screen.getByTestId('tuning-rnnoise-enabled').closest('div.rounded-box');
      expect(within(card as HTMLElement).getByText('was: off')).toBeInTheDocument();
      expect(within(card as HTMLElement).queryByText('reconnects')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent(/^Apply$/);
    });

    it('disables the voice-probability knob and says in visible text why', async () => {
      await renderPanel();

      // Genuinely disabled rather than dimmed, with the reason readable — the
      // package applies RNNoise unconditionally and exposes no such parameter.
      expect(screen.getByTestId('tuning-rnnoise-voice-prob')).toBeDisabled();
      const row = screen.getByTestId('tuning-rnnoise-voice-prob').closest('div.py-1');
      expect(within(row as HTMLElement).getByText(/Not exposed by this build/)).toBeInTheDocument();
    });

    it('carries the 48 kHz / 480-sample footnote', async () => {
      await renderPanel();

      expect(
        within(screen.getByTestId('tuning-section-denoise')).getByText(/48 kHz on 480-sample frames/),
      ).toBeInTheDocument();
    });
  });

  describe('pending treatment and the footer', () => {
    it('disables Apply and reports the applied config when nothing is pending', async () => {
      await renderPanel();

      expect(screen.getByTestId('tuning-apply')).toBeDisabled();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply');
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applied · cfg:[0-9a-f]{8} · \d{1,2}:\d{2}:\d{2}/);
      expect(screen.getByTestId('tuning-status')).toHaveAttribute('aria-live', 'polite');
    });

    it('marks a changed row with all three pending layers and counts it in the status line', async () => {
      const user = await renderPanel();

      await user.selectOptions(screen.getByTestId('tuning-model-translation'), 'gpt-4.1-nano');

      const row = screen.getByTestId('tuning-model-translation').closest('.tuning-pending');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByTitle('Changed, not applied')).toBeInTheDocument();
      expect(within(row as HTMLElement).getByText('was: gpt-4o-mini')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-status')).toHaveTextContent('1 changes pending');
      expect(screen.getByTestId('tuning-apply')).toBeEnabled();
    });

    it('flags a Deepgram connection-level change on the row and in the Apply label', async () => {
      const user = await renderPanel();

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');

      const row = screen.getByTestId('tuning-model-deepgram').closest('.tuning-pending');
      expect(within(row as HTMLElement).getByText('reconnects')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply (reconnects STT)');
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        '1 changes pending · 1 reopens the Deepgram connection',
      );
    });

    it('chips "reconnects STT" on the Models & voices section only once the Deepgram model is pending', async () => {
      const user = await renderPanel();
      const section = screen.getByTestId('tuning-section-models');
      // Translation model and TTS voices don't reopen the connection, so the
      // section chip stays off while nothing is pending.
      expect(within(section).queryByText('reconnects STT')).not.toBeInTheDocument();

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');

      expect(within(section).getByText('reconnects STT')).toBeInTheDocument();
    });

    it('offers Apply at next connect while disconnected, and applying commits locally and clears pending (E5)', async () => {
      const user = await renderPanel({ connectionStatus: 'idle' });

      await user.selectOptions(screen.getByTestId('tuning-model-translation'), 'gpt-4.1-nano');
      const before = screen.getByTestId('tuning-fingerprint-panel').textContent;
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply at next connect');
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        'Not connected · 1 changes will be sent when you connect',
      );

      await user.click(screen.getByTestId('tuning-apply'));

      expect(screen.getByTestId('tuning-apply')).toBeDisabled();
      expect(screen.queryByText('was: gpt-4o-mini')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-fingerprint-panel').textContent).not.toBe(before);
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applied · cfg:[0-9a-f]{8}/);
    });

    it('Revert puts the control back and clears the pending markers', async () => {
      const user = await renderPanel();

      await user.selectOptions(screen.getByTestId('tuning-model-translation'), 'gpt-4.1-nano');
      await user.click(screen.getByTestId('tuning-revert'));

      expect(screen.getByTestId('tuning-model-translation')).toHaveValue('gpt-4o-mini');
      expect(screen.queryByText(/^was: /)).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply')).toBeDisabled();
    });
  });

  describe('apply failure dialog', () => {
    const failure: ApplyResult = {
      ok: false,
      fingerprint: 'cfg:7f3a9c21',
      attempt: 3,
      maxAttempts: 3,
      message: 'The connection to the provider was lost.',
    };

    it('opens the blocking alertdialog once the transport reports the retry budget exhausted', async () => {
      const user = await renderPanel({ applyTuning: async () => failure });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));

      const dialog = await screen.findByTestId('tuning-apply-failed-dialog');
      expect(dialog).toHaveAttribute('role', 'alertdialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(within(dialog).getByText("Couldn't apply the new settings")).toBeInTheDocument();
      expect(dialog).toHaveTextContent(/failed to reopen with the new parameters after 3 attempts/);
      expect(screen.getByTestId('tuning-apply-retry')).toBeInTheDocument();
      expect(screen.getByTestId('tuning-apply-revert')).toBeInTheDocument();
    });

    it('Revert to previous closes the dialog and makes the panel agree with the session again', async () => {
      const user = await renderPanel({ applyTuning: async () => failure });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));
      await screen.findByTestId('tuning-apply-failed-dialog');

      await user.click(screen.getByTestId('tuning-apply-revert'));

      expect(screen.queryByTestId('tuning-apply-failed-dialog')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-model-deepgram')).toHaveValue('nova-3');
      expect(screen.getByTestId('tuning-apply')).toBeDisabled();
    });

    it('Retry sends the same draft to the transport again', async () => {
      const applyTuning = vi.fn(async (_config: ModeTuningConfig) => failure);
      const user = await renderPanel({ applyTuning });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));
      await screen.findByTestId('tuning-apply-failed-dialog');

      await user.click(screen.getByTestId('tuning-apply-retry'));

      await waitFor(() => expect(applyTuning).toHaveBeenCalledTimes(2));
      expect(applyTuning.mock.calls[1][0]).toEqual(applyTuning.mock.calls[0][0]);
    });
  });

  /**
   * Ticket 07: the states of a live Cascade apply as the footer renders them,
   * and the failure dialog's blocking behaviour. Copy is wireframe §7 verbatim.
   */
  describe('reconnecting apply states and the failure dialog (ticket 07)', () => {
    const failure: ApplyResult = {
      ok: false,
      fingerprint: 'cfg:7f3a9c21',
      attempt: 3,
      maxAttempts: 3,
      message: 'The connection to the provider was lost.',
    };

    /** A transport whose promise the test settles by hand, so mid-flight copy is readable. */
    function pausedTransport() {
      let settle: (result: ApplyResult) => void = () => {};
      const applyTuning = vi.fn(
        () =>
          new Promise<ApplyResult>((resolve) => {
            settle = resolve;
          }),
      );
      return { applyTuning, settle: (result: ApplyResult) => settle(result) };
    }

    it('reads the reconnecting copy, with the transport\'s live attempt count, while a Deepgram apply is in flight', async () => {
      const transport = pausedTransport();
      const user = await renderPanel({ applyTuning: transport.applyTuning });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));

      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        'Reconnecting STT with the new parameters… (attempt 1 of 3)',
      );
      expect(screen.getByTestId('tuning-apply')).toBeDisabled();
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Applying…');

      // The server failed attempt 1 and is retrying: the transport's progress
      // is the only thing that sees that, since the promise settles once.
      user.update({ applyProgress: { attempt: 2, maxAttempts: 3, failures: [] } });

      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        'Reconnecting STT with the new parameters… (attempt 2 of 3)',
      );
    });

    it('reads plain "Applying…" for a change that costs no reconnect', async () => {
      const transport = pausedTransport();
      const user = await renderPanel({ applyTuning: transport.applyTuning });

      await user.click(screen.getByTestId('tuning-segmentation-mode-llm'));
      await user.click(screen.getByTestId('tuning-apply'));

      expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applying…$/);
    });

    it('E1 — reads the deferred copy until the server confirms the queued apply', async () => {
      const user = await renderPanel({
        appliedFingerprint: 'cfg:7f3a9c21',
        applyTuning: async () => ({ ok: true, fingerprint: 'cfg:1234abcd', reconnectedStt: false, deferred: true }),
      });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));

      expect(screen.getByTestId('tuning-status')).toHaveTextContent('Applying after the current reply…');

      // Playback ended, the transport flushed the queued config, the server
      // confirmed a new fingerprint: the marker has done its job.
      user.update({ appliedFingerprint: 'cfg:1234abcd' });

      await waitFor(() =>
        expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applied · cfg:1234abcd/),
      );
    });

    it('shows every failed attempt in the dialog\'s log, with a timestamp and the provider\'s reason', async () => {
      const failures = [
        { attempt: 1, message: 'The connection to the provider was lost.', at: new Date('2026-08-15T10:04:31') },
        { attempt: 2, message: 'The provider took too long to respond.', at: new Date('2026-08-15T10:04:33') },
        { attempt: 3, message: 'The connection to the provider was lost.', at: new Date('2026-08-15T10:04:36') },
      ];
      const user = await renderPanel({
        applyTuning: async () => failure,
        applyProgress: { attempt: 3, maxAttempts: 3, failures },
      });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));

      const log = within(await screen.findByTestId('tuning-apply-failed-dialog')).getByTestId(
        'tuning-apply-failed-log',
      );
      expect(within(log).getAllByRole('listitem')).toHaveLength(3);
      expect(log).toHaveTextContent('attempt 2 of 3 · The provider took too long to respond.');
      expect(log).toHaveTextContent(failures[0].at.toLocaleTimeString());
    });

    it('moves focus into the dialog, traps Tab between its two actions, and refuses to be dismissed by Escape', async () => {
      const onClose = vi.fn();
      const user = await renderPanel({ applyTuning: async () => failure, onClose });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));
      await screen.findByTestId('tuning-apply-failed-dialog');

      const retry = screen.getByTestId('tuning-apply-retry');
      const revert = screen.getByTestId('tuning-apply-revert');
      expect(retry).toHaveFocus();

      await user.tab();
      expect(revert).toHaveFocus();
      await user.tab();
      expect(retry).toHaveFocus();
      await user.tab({ shift: true });
      expect(revert).toHaveFocus();

      // No dismiss-by-Escape, and the panel behind it must not close either —
      // that would be a dismissal by another name (wireframe §6).
      await user.keyboard('{Escape}');
      expect(screen.getByTestId('tuning-apply-failed-dialog')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('returns focus to the footer when the dialog closes', async () => {
      const user = await renderPanel({ applyTuning: async () => failure });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.click(screen.getByTestId('tuning-apply'));
      await screen.findByTestId('tuning-apply-failed-dialog');

      await user.click(screen.getByTestId('tuning-apply-revert'));

      // Wireframe §9 asks for `tuning-apply`, but reverting is exactly what
      // leaves nothing pending, so Apply is disabled and cannot hold focus.
      // Revert is the nearest still-operable control in the same footer, which
      // beats dropping focus on `<body>`.
      expect(screen.getByTestId('tuning-revert')).toHaveFocus();
    });
  });

  describe('presets, export / import, reset (ticket 03)', () => {
    it('lists the built-ins under Built-in, with Save as… last', async () => {
      await renderPanel();
      const select = screen.getByTestId('tuning-preset');

      expect(select).toHaveAccessibleName('Preset');
      expect(within(select).getByRole('group', { name: 'Built-in' })).toBeInTheDocument();
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Custom', 'Provider defaults', 'Tuned turn-taking', 'Max denoise', 'Save as…']);
    });

    it('S11 — selecting a preset sets every knob in one action and marks them pending', async () => {
      const user = await renderPanel();

      await user.selectOptions(screen.getByTestId('tuning-preset'), 'Tuned turn-taking');

      // Cascade's endpointing moves; its utterance-end already matches.
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(
        '1 changes pending · 1 reopens the Deepgram connection',
      );
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply (reconnects STT)');
      expect(screen.queryByText('Preset modified')).not.toBeInTheDocument();
    });

    it('shows "Preset modified" once the draft diverges, without clearing the name', async () => {
      const user = await renderPanel();
      await user.selectOptions(screen.getByTestId('tuning-preset'), 'Max denoise');

      await user.selectOptions(screen.getByTestId('tuning-model-translation'), 'gpt-4.1-nano');

      expect(screen.getByTestId('tuning-preset')).toHaveValue('Max denoise');
      expect(screen.getByText('Preset modified')).toBeInTheDocument();
    });

    it('S11 — Save as… reveals the inline name input and files the preset under My presets', async () => {
      const user = await renderPanel();
      expect(screen.queryByTestId('tuning-preset-name')).not.toBeInTheDocument();

      await user.selectOptions(screen.getByTestId('tuning-preset'), '__save');
      expect(screen.getByTestId('tuning-preset-save')).toBeDisabled();
      await user.type(screen.getByTestId('tuning-preset-name'), 'babble-5db-v3');
      await user.click(screen.getByTestId('tuning-preset-save'));

      const select = screen.getByTestId('tuning-preset');
      expect(within(select).getByRole('group', { name: 'My presets' })).toBeInTheDocument();
      expect(select).toHaveValue('babble-5db-v3');
      expect(screen.queryByTestId('tuning-preset-name')).not.toBeInTheDocument();
      expect(window.localStorage.getItem('boostlingo.tuning.presets.v1')).toContain('babble-5db-v3');
    });

    it('Reset to defaults puts every knob back and claims no preset', async () => {
      const user = await renderPanel();
      await user.selectOptions(screen.getByTestId('tuning-preset'), 'Max denoise');

      await user.click(screen.getByTestId('tuning-reset'));

      expect(screen.getByTestId('tuning-preset')).toHaveValue('');
      expect(screen.getByTestId('tuning-status')).toHaveTextContent(/^Applied · cfg:/);
    });

    it('Export writes a file named after the fingerprint and copies it to the clipboard', async () => {
      // jsdom has no object URLs; they are defined here rather than stubbed
      // globally so the rest of `URL` stays real.
      const createObjectURL = vi.fn(() => 'blob:tuning');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
      const downloads: string[] = [];
      const anchorClick = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) {
          downloads.push(this.download);
        });

      try {
        const user = await renderPanel();
        // userEvent installs its own clipboard stub during `setup()`, so the
        // spy has to go on afterwards.
        const writeText = vi.spyOn(navigator.clipboard, 'writeText');
        await user.click(screen.getByTestId('tuning-export'));

        const fingerprint = screen.getByTestId('tuning-fingerprint-panel').textContent ?? '';
        // The colon is legal in a fingerprint and illegal in a Windows filename.
        expect(downloads).toEqual([`tuning-${fingerprint.replace('cfg:', '')}.json`]);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:tuning');
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(DEFAULT_TUNING_CONFIG);
      } finally {
        anchorClick.mockRestore();
        Reflect.deleteProperty(URL, 'createObjectURL');
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
    });

    it('S12 — a config pasted into the importer is loaded and reported', async () => {
      const user = await renderPanel();
      const document = structuredClone(DEFAULT_TUNING_CONFIG);
      document.cascade.translationModel = 'gpt-4.1-nano';

      await user.click(screen.getByTestId('tuning-import'));
      await user.click(screen.getByTestId('tuning-import-paste')); // nothing pasted yet
      expect(screen.getByTestId('tuning-import-paste')).toBeDisabled();

      await user.click(screen.getByTestId('tuning-import-text'));
      await user.paste(JSON.stringify(document));
      await user.click(screen.getByTestId('tuning-import-paste'));

      expect(screen.getByTestId('tuning-model-translation')).toHaveValue('gpt-4.1-nano');
      expect(screen.getByTestId('tuning-import-message')).toHaveTextContent('Imported.');
      expect(screen.getByTestId('tuning-import-message')).toHaveAttribute('aria-live', 'polite');
      expect(screen.queryByTestId('tuning-import-text')).not.toBeInTheDocument();
    });

    it('S12 — a config chosen as a file is loaded through the hidden file input', async () => {
      const user = await renderPanel();
      const document = structuredClone(DEFAULT_TUNING_CONFIG);
      document.cascade.deepgram.model = 'nova-2';
      const file = new File([JSON.stringify(document)], 'tuning-7f3a9c21.json', { type: 'application/json' });

      await user.click(screen.getByTestId('tuning-import'));
      await user.upload(screen.getByTestId('tuning-import-file'), file);

      await waitFor(() => expect(screen.getByTestId('tuning-model-deepgram')).toHaveValue('nova-2'));
      expect(screen.getByTestId('tuning-apply')).toHaveTextContent('Apply (reconnects STT)');
    });

    it('F10 — a malformed file reports the error inline and leaves the draft alone', async () => {
      const user = await renderPanel();
      await user.selectOptions(screen.getByTestId('tuning-model-translation'), 'gpt-4.1-nano');

      await user.click(screen.getByTestId('tuning-import'));
      await user.click(screen.getByTestId('tuning-import-text'));
      await user.paste('{ not a config');
      await user.click(screen.getByTestId('tuning-import-paste'));

      expect(screen.getByTestId('tuning-import-message')).toHaveTextContent(
        "That file isn't a valid tuning config.",
      );
      expect(screen.getByTestId('tuning-model-translation')).toHaveValue('gpt-4.1-nano');
      // The importer stays open so the paste can be corrected.
      expect(screen.getByTestId('tuning-import-text')).toBeInTheDocument();
    });

    it('F11 — an unknown field is dropped and named in the header', async () => {
      const user = await renderPanel();
      const document = structuredClone(DEFAULT_TUNING_CONFIG) as unknown as Record<string, unknown>;
      document.turboMode = true;

      await user.click(screen.getByTestId('tuning-import'));
      await user.click(screen.getByTestId('tuning-import-text'));
      await user.paste(JSON.stringify(document));
      await user.click(screen.getByTestId('tuning-import-paste'));

      expect(screen.getByTestId('tuning-import-message')).toHaveTextContent(
        'Imported. Ignored 1 unknown field(s): turboMode.',
      );
    });

    it('F12 — a retired voice id falls back to the picker default and says so', async () => {
      const user = await renderPanel();
      const document = structuredClone(DEFAULT_TUNING_CONFIG);
      document.cascade.ttsVoiceA = 'retired-voice-id';

      await user.click(screen.getByTestId('tuning-import'));
      await user.click(screen.getByTestId('tuning-import-text'));
      await user.paste(JSON.stringify(document));
      await user.click(screen.getByTestId('tuning-import-paste'));

      expect(screen.getByTestId('tuning-import-message')).toHaveTextContent(
        'retired-voice-id is no longer available — using 21m00Tcm4TlvDq8ikWAM.',
      );
      expect(screen.getByTestId('tuning-voice-a')).toHaveValue('21m00Tcm4TlvDq8ikWAM');
    });
  });

  describe('loading and chrome', () => {
    it('renders a skeleton stack, and no knobs, until the capabilities request settles', () => {
      vi.stubGlobal(
        'fetch',
        createRealtimeFetchRouter({
          capabilitiesResponse: { ok: true, status: 200, json: () => new Promise<unknown>(() => {}), text: async () => '' },
        }),
      );
      render(<Harness />);

      expect(screen.getByTestId('tuning-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('tuning-section-denoise')).not.toBeInTheDocument();
      expect(screen.getByTestId('tuning-panel').querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    });

    it('closes on the header button and on Escape from inside the panel', async () => {
      const onClose = vi.fn();
      const user = await renderPanel({ onClose });

      screen.getByTestId('tuning-close').focus();
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);

      await user.click(screen.getByTestId('tuning-close'));
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('gives the panel and its accordions accessible names and native disclosure semantics', async () => {
      await renderPanel();

      expect(screen.getByTestId('tuning-panel')).toHaveAccessibleName('Tuning panel');
      expect(screen.getByTestId('tuning-close')).toHaveAccessibleName('Close tuning panel');
      const denoise = screen.getByTestId('tuning-section-denoise');
      expect(denoise.tagName).toBe('DETAILS');
      expect(denoise.querySelector('summary')?.textContent).toContain('Denoise chain');
      // Segmented controls are real radios in a named radiogroup.
      const group = screen.getByRole('radiogroup', { name: 'Transcript check' });
      expect(within(group).getAllByRole('radio')).toHaveLength(3);
    });
  });

  /**
   * Ticket 18 — the curated pickers, end to end from this panel.
   *
   * S31's component half (every picker is a fixed list, no free text) is above;
   * this is its end-to-end half: what is picked here is what leaves the panel
   * in the projected document and what moves the fingerprint. The backend half
   * — the same six values reaching the providers, and an out-of-allow-list one
   * falling back instead of killing the session — is
   * `backend/tests/test_tuning_pickers.py`.
   */
  describe('ticket 18', () => {
    /** The KnobRow a control sits in, for reading its chips. */
    function rowOf(testId: string): HTMLElement {
      const row = screen.getByTestId(testId).closest('div.py-1');
      if (!row) throw new Error(`${testId} is not inside a knob row`);
      return row as HTMLElement;
    }

    it('S31 — every Cascade picker carries its choice into the projected document', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });

      await user.selectOptions(screen.getByTestId('tuning-model-deepgram'), 'nova-2');
      await user.selectOptions(screen.getByTestId('tuning-model-translation'), 'gpt-4.1-nano');
      await user.selectOptions(screen.getByTestId('tuning-segmentation-model'), 'gpt-4.1-mini');
      await user.selectOptions(screen.getByTestId('tuning-transcript-check-model'), 'gpt-4.1-mini');
      await user.selectOptions(screen.getByTestId('tuning-voice-a'), 'ErXwobaYiN019PkySvjV');
      await user.selectOptions(screen.getByTestId('tuning-voice-b'), '21m00Tcm4TlvDq8ikWAM');
      await user.click(screen.getByTestId('tuning-apply'));

      const cascade = await cascadeBlockOf(applyTuning);
      expect(cascade.deepgram.model).toBe('nova-2');
      expect(cascade.translationModel).toBe('gpt-4.1-nano');
      expect(cascade.segmentation.model).toBe('gpt-4.1-mini');
      expect(cascade.transcriptCheck.model).toBe('gpt-4.1-mini');
      expect(cascade.ttsVoiceA).toBe('ErXwobaYiN019PkySvjV');
      expect(cascade.ttsVoiceB).toBe('21m00Tcm4TlvDq8ikWAM');
    });

    it('S31 — both Realtime pickers carry their choice into the projected document', async () => {
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning, initialMode: 'realtime' });

      await user.selectOptions(screen.getByTestId('tuning-model-realtime'), 'gpt-realtime-mini');
      await user.selectOptions(screen.getByTestId('tuning-voice-realtime'), 'marin');
      await user.click(screen.getByTestId('tuning-apply'));

      const realtime = await realtimeBlockOf(applyTuning);
      expect(realtime.model).toBe('gpt-realtime-mini');
      expect(realtime.voice).toBe('marin');
    });

    it('S31 — picking a model moves the fingerprint the panel reports', async () => {
      const user = await renderPanel({ connectionStatus: 'idle' });
      const before = screen.getByTestId('tuning-fingerprint-panel').textContent;

      await user.selectOptions(screen.getByTestId('tuning-voice-a'), 'ErXwobaYiN019PkySvjV');
      await user.click(screen.getByTestId('tuning-apply'));

      const after = screen.getByTestId('tuning-fingerprint-panel').textContent;
      expect(after).toMatch(/^cfg:[0-9a-f]{8}$/);
      expect(after).not.toBe(before);
    });

    it('marks the Realtime model and voice rows "applies at next connect"', async () => {
      const user = await renderPanel();

      // Cascade's pickers all apply live (the Deepgram model via a reconnect),
      // so the marker must not appear there.
      expect(screen.queryByText('applies at next connect')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'switch mode' }));

      expect(within(rowOf('tuning-model-realtime')).getByText('applies at next connect')).toBeInTheDocument();
      expect(within(rowOf('tuning-voice-realtime')).getByText('applies at next connect')).toBeInTheDocument();
    });

    it('names the server-side allow-list in a footnote in both modes', async () => {
      const user = await renderPanel();

      const cascadeNote = screen.getByTestId('tuning-models-allow-list-note');
      expect(cascadeNote).toHaveTextContent("server's allow-list");
      expect(cascadeNote).toHaveTextContent('GET /api/tuning/capabilities');
      expect(cascadeNote).toHaveTextContent('falls back to the default');

      await user.click(screen.getByRole('button', { name: 'switch mode' }));

      const realtimeNote = screen.getByTestId('tuning-models-allow-list-note');
      expect(realtimeNote).toHaveTextContent("server's allow-list");
      expect(realtimeNote).toHaveTextContent('rejected with a 400');
    });

    it('renders the fallback, not an orphan option, for a stored id the allow-list no longer has', async () => {
      const stored = structuredClone(DEFAULT_TUNING_CONFIG);
      stored.cascade.deepgram.model = 'nova-1-retired';
      stored.cascade.ttsVoiceA = 'retired-voice-id';
      window.localStorage.setItem(
        'boostlingo.tuning.v1',
        JSON.stringify({ schemaVersion: 1, draft: stored, applied: null }),
      );

      await renderPanel();

      // The id is dropped on the way in (ticket 03's `parseImported`), so the
      // select holds the picker default and offers only what the server serves
      // — a `<select>` whose value isn't among its options would silently
      // display the wrong model.
      await waitFor(() => expect(screen.getByTestId('tuning-model-deepgram')).toHaveValue('nova-3'));
      expect(
        within(screen.getByTestId('tuning-model-deepgram'))
          .getAllByRole('option')
          .map((option) => option.getAttribute('value')),
      ).toEqual(['nova-3', 'nova-2']);
      expect(screen.getByTestId('tuning-voice-a')).toHaveValue('21m00Tcm4TlvDq8ikWAM');
      expect(screen.queryByText(/retired/i)).not.toBeInTheDocument();
    });
  });

  /**
   * Ticket 16 (S29's component half) — the noisereduce row goes live once the
   * server reports the `bench` extra installed; the DeepFilterNet row it sits
   * next to (ticket 07) already covers the same `ServerStage`/`stageBadge`
   * machinery, so this just proves noisereduce is wired the same way. The
   * backend half — `find_spec` detection and `/api/tuning/capabilities`
   * reporting `installed: true` — is `backend/tests/test_denoise.py`.
   */
  describe('ticket 16', () => {
    it('is disabled with the server-reported reason when noisereduce is not installed (default capabilities)', async () => {
      await renderPanel();

      expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeDisabled();
      expect(screen.getByTestId('tuning-noisereduce-prop-decrease')).toBeDisabled();
      expect(screen.getByTestId('tuning-noisereduce-stationary')).toBeDisabled();
      expect(screen.getByTestId('tuning-noisereduce-non-stationary')).toBeDisabled();
      expect(screen.getByTestId('tuning-noisereduce-unavailable')).toHaveTextContent('not installed');
      // The fix, in visible text — never only in a `title` (wireframe §9).
      expect(screen.getByText('run `uv sync --extra bench` in backend/')).toBeInTheDocument();
    });

    it('goes live — toggle, propDecrease and the stationary/non-stationary join all enabled — once the server reports it installed', async () => {
      vi.stubGlobal('fetch', capabilitiesWith({ noisereduce: { installed: true, liveCapable: true } }));
      await renderPanel();

      await waitFor(() => expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeEnabled());
      expect(screen.getByTestId('tuning-noisereduce-prop-decrease')).toBeEnabled();
      expect(screen.getByTestId('tuning-noisereduce-stationary')).toBeEnabled();
      expect(screen.getByTestId('tuning-noisereduce-non-stationary')).toBeEnabled();
      expect(screen.queryByTestId('tuning-noisereduce-unavailable')).not.toBeInTheDocument();
    });

    it('toggling and changing the params updates the projected cascade document and moves the fingerprint', async () => {
      vi.stubGlobal('fetch', capabilitiesWith({ noisereduce: { installed: true, liveCapable: true } }));
      const applyTuning = acceptingTransport();
      const user = await renderPanel({ applyTuning });
      await waitFor(() => expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeEnabled());
      const before = screen.getByTestId('tuning-fingerprint-panel').textContent;

      await user.click(screen.getByTestId('tuning-noisereduce-enabled'));
      fireEvent.change(screen.getByTestId('tuning-noisereduce-prop-decrease'), { target: { value: '0.75' } });
      await user.click(screen.getByTestId('tuning-noisereduce-non-stationary'));
      await user.click(screen.getByTestId('tuning-apply'));

      const cascade = await cascadeBlockOf(applyTuning);
      expect(cascade.denoise.noisereduce.enabled).toBe(true);
      expect(cascade.denoise.noisereduce.propDecrease).toBeCloseTo(0.75);
      expect(cascade.denoise.noisereduce.stationary).toBe(false);
      const after = screen.getByTestId('tuning-fingerprint-panel').textContent;
      expect(after).not.toBe(before);
    });

    it('renders noisereduce Cascade only in Realtime even when installed', async () => {
      vi.stubGlobal('fetch', capabilitiesWith({ noisereduce: { installed: true, liveCapable: true } }));
      const user = await renderPanel();
      await waitFor(() => expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeEnabled());

      await user.click(screen.getByRole('button', { name: 'switch mode' }));

      expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeDisabled();
      // DeepFilterNet's row carries the same badge, so both server stages show it.
      expect(screen.getAllByText('Cascade only')).toHaveLength(2);
    });

    it('keeps Demucs and denoiser (DNS64) permanently disabled regardless of the noisereduce install state', async () => {
      vi.stubGlobal('fetch', capabilitiesWith({ noisereduce: { installed: true, liveCapable: true } }));
      await renderPanel();
      await waitFor(() => expect(screen.getByTestId('tuning-noisereduce-enabled')).toBeEnabled());

      expect(screen.getByTestId('tuning-demucs-enabled')).toBeDisabled();
      expect(screen.getByTestId('tuning-dns-enabled')).toBeDisabled();
    });
  });

  describe('ticket 17', () => {
    it('brings the DeepFilterNet row live with both of its parameters once the server reports it installed', async () => {
      // Story AC 5.1's DeepFilterNet half: the row is only ever live when
      // `uv sync --extra denoise` has actually been run on the server, and
      // when it is, both DFN-specific knobs are usable, not just the toggle.
      vi.stubGlobal('fetch', capabilitiesWith({ deepfilternet: { installed: true, liveCapable: true } }));
      await renderPanel();

      await waitFor(() => expect(screen.getByTestId('tuning-dfn-enabled')).toBeEnabled());
      expect(screen.getByTestId('tuning-dfn-attenuation-limit')).toBeEnabled();
      expect(screen.getByTestId('tuning-dfn-post-filter')).toBeEnabled();
      expect(screen.queryByTestId('tuning-dfn-unavailable')).not.toBeInTheDocument();
    });
  });
});

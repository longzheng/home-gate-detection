import type { ClassifyLabels } from './classifier.js';

export class GateState {
    private candidate: ClassifyLabels | null = null;
    private count = 0;
    private lastReading = -Infinity;
    private confirmedAt = -Infinity;
    private confirmed: ClassifyLabels | null = null;

    constructor(
        private readonly staleMs: number,
        private readonly maxGapMs: number,
    ) {}

    fail() {
        this.candidate = null;
        this.count = 0;
    }

    read(classification: ClassifyLabels, capturedAt: number, now: number) {
        this.current(now);
        if (now - capturedAt >= this.staleMs) {
            this.fail();
            return;
        }
        if (
            classification !== this.candidate ||
            capturedAt - this.lastReading > this.maxGapMs
        ) {
            this.fail();
        }
        this.candidate = classification;
        this.lastReading = capturedAt;
        this.count = Math.min(this.count + 1, 2);
        if (this.count >= 2) {
            this.confirmed = classification;
            this.confirmedAt = capturedAt;
        }
    }

    current(now: number): ClassifyLabels | null {
        if (now - this.confirmedAt >= this.staleMs) {
            if (this.confirmed !== null) this.fail();
            this.confirmed = null;
        }
        return this.confirmed;
    }
}

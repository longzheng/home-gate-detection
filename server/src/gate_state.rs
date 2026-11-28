use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Label {
    Closed,
    Open,
}

#[derive(Clone, Copy)]
pub struct Reading {
    pub label: Label,
    pub captured_at: Instant,
}

impl Reading {
    pub fn fresh_at(self, now: Instant, timeout: Duration) -> bool {
        now.saturating_duration_since(self.captured_at) < timeout
    }
}

pub struct GateState {
    candidate: Option<Reading>,
    confirmed: Option<Reading>,
    stale_timeout: Duration,
    max_gap: Duration,
}

impl GateState {
    pub fn new(stale_timeout: Duration, max_gap: Duration) -> Self {
        Self {
            candidate: None,
            confirmed: None,
            stale_timeout,
            max_gap,
        }
    }

    pub fn fail(&mut self) {
        self.candidate = None;
    }

    pub fn read(&mut self, reading: Reading, now: Instant) -> Option<Reading> {
        self.current(now);
        if !reading.fresh_at(now, self.stale_timeout) {
            self.fail();
            return None;
        }
        let matches_candidate = self.candidate.is_some_and(|previous| {
            previous.label == reading.label
                && reading.captured_at.duration_since(previous.captured_at) <= self.max_gap
        });
        self.candidate = Some(reading);
        if matches_candidate {
            self.confirmed = Some(reading);
            return self.confirmed;
        }
        None
    }

    fn current(&mut self, now: Instant) -> Option<Label> {
        if self
            .confirmed
            .is_some_and(|reading| !reading.fresh_at(now, self.stale_timeout))
        {
            self.fail();
            self.confirmed = None;
        }
        self.confirmed.map(|reading| reading.label)
    }
}

#[cfg(test)]
mod tests {
    use super::{GateState, Label, Label::*, Reading};
    use std::time::{Duration, Instant};

    struct TestState {
        gate: GateState,
        start: Instant,
    }

    impl TestState {
        fn new(stale: u64, gap: u64) -> Self {
            Self {
                gate: GateState::new(Duration::from_millis(stale), Duration::from_millis(gap)),
                start: Instant::now(),
            }
        }

        fn read(&mut self, label: Label, captured: u64, now: u64) {
            self.gate.read(
                Reading {
                    label,
                    captured_at: self.start + Duration::from_millis(captured),
                },
                self.start + Duration::from_millis(now),
            );
        }

        fn current(&mut self, millis: u64) -> Option<Label> {
            self.gate
                .current(self.start + Duration::from_millis(millis))
        }
    }

    #[test]
    fn startup_and_changes_require_two_matching_readings() {
        let mut state = TestState::new(30_000, 5_000);
        assert_eq!(state.current(0), None);
        state.read(Closed, 0, 0);
        assert_eq!(state.current(0), None);
        state.read(Closed, 1_000, 1_000);
        assert_eq!(state.current(1_000), Some(Closed));
        state.read(Open, 2_000, 2_000);
        assert_eq!(state.current(2_000), Some(Closed));
        state.read(Open, 3_000, 3_000);
        assert_eq!(state.current(3_000), Some(Open));
    }

    #[test]
    fn errors_break_pending_confirmation() {
        let mut state = TestState::new(30_000, 5_000);
        state.read(Open, 0, 0);
        state.gate.fail();
        state.read(Open, 1_000, 1_000);
        assert_eq!(state.current(1_000), None);
        state.read(Open, 2_000, 2_000);
        assert_eq!(state.current(2_000), Some(Open));
    }

    #[test]
    fn long_gaps_break_pending_confirmation() {
        let mut state = TestState::new(30_000, 5_000);
        state.read(Closed, 0, 0);
        state.read(Closed, 5_001, 5_001);
        assert_eq!(state.current(5_001), None);
        state.read(Closed, 6_000, 6_000);
        assert_eq!(state.current(6_000), Some(Closed));
    }

    #[test]
    fn stale_state_expires_and_recovery_requires_two_readings() {
        let mut state = TestState::new(30_000, 5_000);
        state.read(Closed, 0, 0);
        state.read(Closed, 1_000, 1_000);
        state.gate.fail();
        assert_eq!(state.current(30_999), Some(Closed));
        assert_eq!(state.current(31_000), None);
        state.read(Closed, 32_000, 32_000);
        assert_eq!(state.current(32_000), None);
        state.read(Closed, 33_000, 33_000);
        assert_eq!(state.current(33_000), Some(Closed));
    }

    #[test]
    fn alternating_readings_do_not_refresh_confirmed_state() {
        let mut state = TestState::new(3_000, 2_000);
        state.read(Closed, 0, 0);
        state.read(Closed, 1_000, 1_000);
        state.read(Open, 2_000, 2_000);
        state.read(Closed, 3_000, 3_000);
        state.read(Open, 4_000, 4_000);
        assert_eq!(state.current(4_000), None);
    }

    #[test]
    fn stale_in_flight_readings_are_rejected_and_stable_readings_refresh_state() {
        let mut state = TestState::new(3_000, 2_000);
        state.read(Open, 0, 3_000);
        state.read(Open, 3_001, 3_001);
        assert_eq!(state.current(3_001), None);
        state.read(Open, 4_000, 4_000);
        state.read(Open, 5_000, 5_000);
        assert_eq!(state.current(7_999), Some(Open));
        assert_eq!(state.current(8_000), None);
    }
}

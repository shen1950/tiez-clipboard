use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const RETRY_DELAYS_MS: [u64; 6] = [50, 100, 200, 400, 800, 1000];

/// Events are authoritative even when delayed rendering leaves the sequence unchanged.
/// The callback returns true only when no readable payload was found.
pub(super) fn run(
    events: Receiver<()>,
    mut capture: impl FnMut() -> bool,
    sequence: impl Fn() -> u32,
    mut last_sequence: u32,
) {
    let mut retry = None;
    loop {
        let delay = retry
            .map(|index: usize| Duration::from_millis(RETRY_DELAYS_MS[index]))
            .unwrap_or(POLL_INTERVAL);
        let notified = match events.recv_timeout(delay) {
            Ok(()) => true,
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let current_sequence = sequence();
        let changed = current_sequence != last_sequence;
        if !notified && !changed && retry.is_none() {
            continue;
        }
        if notified || changed {
            retry = None;
        }
        // Sample before capture: a newer copy during capture must remain pending.
        last_sequence = current_sequence;
        if capture() {
            let next = retry.map_or(0, |index| index + 1);
            retry = (next < RETRY_DELAYS_MS.len()).then_some(next);
        } else {
            retry = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc,
    };

    #[test]
    fn retries_unreadable_payload_without_a_new_event_or_sequence() {
        let (tx, rx) = mpsc::sync_channel(1);
        let (captured_tx, captured_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut attempts = 0;
            run(
                rx,
                || {
                    attempts += 1;
                    captured_tx.send(attempts).unwrap();
                    attempts < 3
                },
                || 7,
                7,
            );
        });
        tx.send(()).unwrap();
        for expected in 1..=3 {
            assert_eq!(
                captured_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
                expected
            );
        }
        assert!(captured_rx
            .recv_timeout(Duration::from_millis(650))
            .is_err());
        // A second notification with the SAME sequence still requires reading.
        tx.send(()).unwrap();
        assert_eq!(captured_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 4);
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn polling_recovers_a_missed_notification_without_reading_unchanged_data() {
        let (tx, rx) = mpsc::sync_channel(1);
        let (captured_tx, captured_rx) = mpsc::channel();
        let seq = Arc::new(AtomicU32::new(10));
        let worker_seq = seq.clone();
        let worker = std::thread::spawn(move || {
            run(
                rx,
                || {
                    captured_tx.send(()).unwrap();
                    false
                },
                || worker_seq.load(Ordering::SeqCst),
                10,
            );
        });
        assert!(captured_rx
            .recv_timeout(Duration::from_millis(650))
            .is_err());
        seq.store(11, Ordering::SeqCst);
        captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(captured_rx
            .recv_timeout(Duration::from_millis(650))
            .is_err());
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn unreadable_payload_retries_are_bounded() {
        let (tx, rx) = mpsc::sync_channel(1);
        let (captured_tx, captured_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            run(
                rx,
                || {
                    captured_tx.send(()).unwrap();
                    true
                },
                || 1,
                1,
            );
        });
        tx.send(()).unwrap();
        for _ in 0..=RETRY_DELAYS_MS.len() {
            captured_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert!(captured_rx
            .recv_timeout(Duration::from_millis(650))
            .is_err());
        drop(tx);
        worker.join().unwrap();
    }
}

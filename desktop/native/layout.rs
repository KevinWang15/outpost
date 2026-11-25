// Persistent pane identities keep terminals alive when their layout changes.
pub type Id = usize;
pub const GAP: f32 = 6.;
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Axis {
    Across,
    Down,
}
#[derive(Clone)]
pub enum Layout {
    Pane(Id),
    Split {
        id: Id,
        axis: Axis,
        ratio: f32,
        first: Box<Layout>,
        second: Box<Layout>,
    },
}
impl Layout {
    pub fn pane_order(&self, ids: &mut Vec<Id>) {
        match self {
            Self::Pane(id) => ids.push(*id),
            Self::Split { first, second, .. } => {
                first.pane_order(ids);
                second.pane_order(ids);
            }
        }
    }
    fn minimum(&self, direction: Axis) -> f32 {
        match self {
            Self::Pane(_) => {
                if direction == Axis::Across {
                    180.
                } else {
                    128.
                }
            }
            Self::Split {
                axis,
                first,
                second,
                ..
            } => {
                let a = first.minimum(direction);
                let b = second.minimum(direction);
                if *axis == direction {
                    a + b + GAP
                } else {
                    a.max(b)
                }
            }
        }
    }
    pub fn first_extent(&self, total: f32) -> f32 {
        let Self::Split {
            axis,
            ratio,
            first,
            second,
            ..
        } = self
        else {
            return total;
        };
        let space = (total - GAP).max(0.);
        let a = first.minimum(*axis);
        let b = second.minimum(*axis);
        if space < a + b {
            (space * a / (a + b)).round()
        } else {
            (space * ratio).clamp(a, space - b).round()
        }
    }
    pub fn first(&self) -> Id {
        match self {
            Self::Pane(id) => *id,
            Self::Split { first, .. } => first.first(),
        }
    }
    pub fn contains(&self, needle: Id) -> bool {
        match self {
            Self::Pane(id) => *id == needle,
            Self::Split { first, second, .. } => first.contains(needle) || second.contains(needle),
        }
    }
    pub fn split(&mut self, at: Id, id: Id, axis: Axis, other: Layout) -> bool {
        self.insert_at(at, id, axis, other, false)
    }
    pub fn insert_at(&mut self, at: Id, id: Id, axis: Axis, other: Layout, before: bool) -> bool {
        match self {
            Self::Pane(n) if *n == at => {
                let (left, right) = if before {
                    (other, Self::Pane(at))
                } else {
                    (Self::Pane(at), other)
                };
                *self = Self::Split {
                    id,
                    axis,
                    ratio: 0.5,
                    first: Box::new(left),
                    second: Box::new(right),
                };
                true
            }
            Self::Pane(_) => false,
            Self::Split { first, second, .. } => {
                if first.contains(at) {
                    first.insert_at(at, id, axis, other, before)
                } else {
                    second.insert_at(at, id, axis, other, before)
                }
            }
        }
    }
    pub fn remove(self, at: Id) -> Option<Self> {
        match self {
            Self::Pane(id) => (id != at).then_some(Self::Pane(id)),
            Self::Split {
                id,
                axis,
                ratio,
                first,
                second,
            } => {
                let (left, right) = if first.contains(at) {
                    (first.remove(at), Some(*second))
                } else {
                    (Some(*first), second.remove(at))
                };
                match (left, right) {
                    (Some(a), Some(b)) => Some(Self::Split {
                        id,
                        axis,
                        ratio,
                        first: Box::new(a),
                        second: Box::new(b),
                    }),
                    (a, b) => a.or(b),
                }
            }
        }
    }
    pub fn resize(&mut self, split: Id, value: f32) -> bool {
        match self {
            Self::Split { id, ratio, .. } if *id == split => {
                *ratio = value.clamp(0.05, 0.95);
                true
            }
            Self::Split { first, second, .. } => {
                first.resize(split, value) || second.resize(split, value)
            }
            _ => false,
        }
    }
}
pub(super) fn next_id() -> Id {
    static IDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
pub struct Tab {
    pub id: Id,
    pub layout: Layout,
    pub active: Id,
    pub name: String,
    pub zoom: bool,
}
impl Tab {
    pub fn single(id: Id) -> Self {
        Self {
            id: next_id(),
            layout: Layout::Pane(id),
            active: id,
            name: String::new(),
            zoom: false,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_nested_pane_collapses_only_its_split() {
        let mut n = Layout::Pane(1);
        assert!(n.split(1, 10, Axis::Across, Layout::Pane(2)));
        assert!(n.split(2, 11, Axis::Down, Layout::Pane(3)));
        assert!(n.resize(11, 0.8));
        let n = n.remove(2).unwrap();
        assert!(n.contains(3) && n.contains(1) && !n.contains(2));
        assert_eq!(n.remove(1).unwrap().first(), 3)
    }
}

type BoardKey = 'today' | 'week' | 'dark';
type SortKey = 'likes' | 'ratio' | 'fanRatio' | 'collected' | 'comments';
interface FoodNote {
  noteId: string;
  title: string;
  author: string;
  type: 'video' | 'normal';
  publishedAt: string | null;
  likes: number | null;
  collected: number | null;
  comments: number | null;
  fans: number | null;
  ratio: number | null;
  fanRatio: number | null;
  baseline: number | null;
  boards: BoardKey[];
  thumbUrl: string | null;
  sourceUrl: string | null;
  sourceNavigation?: { noteId: string; shortLink: string } | null;
  sourceNavigationState?: 'ready' | 'missing' | 'unavailable';
}
interface RoundItem { snapshotId: string; scheduledAt: string; status: string; count: number; label?: string }
interface RoundData {
  snapshotId: string; notes: FoodNote[]; scheduledAt: string; finishedAt: string;
  status: string; partialReason: string | null; count: number; nextCursor: string | null;
  coverage?: { notice?: string };
}
interface FoodError extends Error { code?: string }

type BoardKey = 'today' | 'week' | 'rising' | 'engage';
type SortKey = 'likes' | 'ratio' | 'fanRatio' | 'collectRatio' | 'engageRatio' | 'collected' | 'comments' | 'shared';
interface RisingAccount {
  authorId: string;
  author: string | null;
  fans: number | null;
  fansBefore: number | null;
  fansDelta: number;
  gainRate?: number | null;
  spikeDate?: string | null;
  spikeGain?: number | null;
  source?: 'pgy' | 'observed' | null;
  observedAt: string | null;
  baselineAt: string | null;
  spanHours: number | null;
  notes: { noteId: string; title: string; likes: number | null; collected: number | null; publishedAt: string | null }[];
}
interface FoodNote {
  authorId?: string;
  authorNavigation?: {authorId:string;token:string;source:string}|null;
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
  collectRatio: number | null;
  engageRatio?: number | null;
  shared?: number | null;
  contentStatus?: 'confirmed' | 'unconfirmed' | null;
  contentReason?: string | null;
  baseline: number | null;
  boards: BoardKey[];
  thumbUrl: string | null;
  thumbFallbackUrl?: string | null;
  sourceUrl: string | null;
  sourceNavigation?: { noteId: string; shortLink: string } | null;
  sourceNavigationState?: 'ready' | 'missing' | 'unavailable';
}
interface RoundItem { snapshotId: string; scheduledAt: string; status: string; count: number; label?: string }
interface RoundData {
  snapshotId: string; notes: FoodNote[]; scheduledAt: string; finishedAt: string;
  status: string; partialReason: string | null; count: number; nextCursor: string | null;
  accounts?: RisingAccount[];
  coverage?: { notice?: string };
}
interface FoodError extends Error { code?: string }
interface NoteContent {
  status: 'available' | 'missing';
  desc: string;
  bodyComplete: boolean;
  images: string[];
  imageCount: number | null;
  imagesComplete: boolean;
  videoUrl: string | null;
  capturedAt: string | null;
}

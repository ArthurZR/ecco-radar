export type DiffPart = { kind: 'same' | 'add' | 'del'; text: string };

/** Word-level diff (LCS). Drafts are short, so the quadratic table is fine. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).filter((x) => x !== '');
  const B = b.split(/(\s+)/).filter((x) => x !== '');
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push('del', A[i++]!);
    } else {
      push('add', B[j++]!);
    }
  }
  while (i < n) push('del', A[i++]!);
  while (j < m) push('add', B[j++]!);
  return out;
}

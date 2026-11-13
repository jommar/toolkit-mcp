import type { PrComment, PrReviewComment, PrReviewSubmitted, PullRequestDetail } from './github-client.js';

/** Small acknowledgement for a write: enough to confirm it landed and to link to it. No body echo. */
export interface PrUpdateAck {
  number: number;
  state: PullRequestDetail['state'];
  draft: boolean;
  title: string;
  htmlUrl: string;
  updatedAt: string;
  headBranch: string;
  baseBranch: string;
}

export interface PrCommentAck {
  id: number;
  htmlUrl: string;
}

export interface PrReviewCommentAck extends PrCommentAck {
  path: string;
  line: number;
}

export interface PrReviewAck extends PrCommentAck {
  state: string;
}

export function toPrUpdateAck(pr: PullRequestDetail): PrUpdateAck {
  return {
    number: pr.number,
    state: pr.state,
    draft: pr.draft,
    title: pr.title,
    htmlUrl: pr.htmlUrl,
    updatedAt: pr.updatedAt,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
  };
}

export function toPrCommentAck(c: PrComment): PrCommentAck {
  return { id: c.id, htmlUrl: c.htmlUrl };
}

export function toPrReviewCommentAck(c: PrReviewComment): PrReviewCommentAck {
  return { id: c.id, path: c.path, line: c.line, htmlUrl: c.htmlUrl };
}

export function toPrReviewAck(r: PrReviewSubmitted): PrReviewAck {
  return { id: r.id, state: r.state, htmlUrl: r.htmlUrl };
}

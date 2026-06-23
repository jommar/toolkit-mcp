import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { describeGitHubError } from './github/github-client.js';
import { describeError } from './jira/jira-client.js';

describe('describeGitHubError', () => {
  it('formats axios error with status and message', () => {
    const err = new axios.AxiosError('Not found', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status: 404,
      data: { message: 'Not Found' },
      headers: {},
      statusText: 'Not Found',
    } as any);
    const msg = describeGitHubError(err);
    expect(msg).toBe('GitHub API error (404): Not Found');
  });

  it('formats axios error without status', () => {
    const err = new axios.AxiosError('Network error', 'ECONNABORTED');
    const msg = describeGitHubError(err);
    expect(msg).toBe('GitHub API error: Network error');
  });

  it('formats non-axios error as-is', () => {
    const msg = describeGitHubError(new Error('Random error'));
    expect(msg).toBe('Random error');
  });

  it('formats string errors', () => {
    const msg = describeGitHubError('just a string');
    expect(msg).toBe('just a string');
  });

  it('falls back to err.message when data is missing', () => {
    const err = new axios.AxiosError('timeout of 30000ms exceeded', 'ECONNABORTED');
    const msg = describeGitHubError(err);
    expect(msg).toBe('GitHub API error: timeout of 30000ms exceeded');
  });

  it('formats GitHub 422 error with errors array', () => {
    const err = new axios.AxiosError(
      'Request failed with status code 422',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 422,
        data: {
          message: 'Validation Failed',
          errors: [
            {
              message: 'The listed repos cannot be searched',
              resource: 'Search',
              field: 'q',
              code: 'invalid',
            },
          ],
        },
        headers: {},
        statusText: 'Unprocessable Entity',
      } as any,
    );
    // describeGitHubError now includes errors array details
    const msg = describeGitHubError(err);
    expect(msg).toBe('GitHub API error (422): Validation Failed: The listed repos cannot be searched');
  });
});

describe('describeError (Jira)', () => {
  it('formats Jira 422 with errorMessages', () => {
    const err = new axios.AxiosError(
      'Request failed with status code 422',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 422,
        data: {
          errorMessages: ['Issue does not exist'],
        },
        headers: {},
        statusText: 'Unprocessable Entity',
      } as any,
    );
    const msg = describeError(err);
    expect(msg).toBe('Jira API error (422): Issue does not exist');
  });

  it('formats Jira error with errors object', () => {
    const err = new axios.AxiosError(
      'Request failed with status code 400',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 400,
        data: {
          errors: { summary: 'Summary is required' },
        },
        headers: {},
        statusText: 'Bad Request',
      } as any,
    );
    const msg = describeError(err);
    expect(msg).toBe('Jira API error (400): summary: Summary is required');
  });

  it('formats non-axios error as-is', () => {
    const msg = describeError(new TypeError('wrong type'));
    expect(msg).toBe('wrong type');
  });
});

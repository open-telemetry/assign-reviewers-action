import { strict as assert } from 'assert';
import * as util from 'util';

import * as core from '@actions/core';
import * as github from '@actions/github';
import { validateConfig } from './models/config';
import { getChangedFiles, getAssignedUsers, getPullAuthor, getRefs, getReviewers, getReviews, loadYaml } from './utils';

async function main() {
    const client = github.getOctokit(core.getInput('repo-token', { required: true }));
    const configFilePath = core.getInput('config-file', { required: true });
    const assignUsers = core.getBooleanInput('assign-users', { required: true })
    const requestUserReviews = core.getBooleanInput('request-user-reviews', { required: true })

    const { base, head } = getRefs();

    core.debug(`Base commit: ${base}`)
    core.debug(`Head commit: ${head}`)

    const configFile = await loadYaml(client, head, configFilePath);
    const config = validateConfig(configFile);

    const author = await getPullAuthor(client);

    if (config.ignoredAuthors.has(author)) {
        return;
    }

    const changedFiles = await getChangedFiles(client, base, head);
    const assignees = getAssignedUsers(config, changedFiles);

    core.info(`${assignees.length} assigned users found ${assignees.join(' ')}`);

    if (assignUsers && assignees.length > 0) {
        core.info('Adding assignees');
        const addAssigneesResult = await client.rest.issues.addAssignees({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: github.context.issue.number,
            assignees,
        });
        core.debug(util.inspect(addAssigneesResult));
    }


    const reviewers = new Set<string>(assignees);
    if (reviewers.has(author) || reviewers.has(author.toLowerCase())) core.info('PR author cannot be a reviewer');
    reviewers.delete(author);
    reviewers.delete(author.toLowerCase());

    // Do not want to re-request when reviewers have already been requested
    const oldReviewers = await getReviewers(client);
    for (const reviewer of oldReviewers) {
        if (!reviewer) continue;
        core.info(`${reviewer.login} has already been requested`);
        reviewers.delete(reviewer.login);
    }

    // Do not want to re-request when reviewers have already approved/rejected
    const previousReviews = await getReviews(client);
    for (const review of previousReviews) {
        if (!review.user) continue;
        if (!reviewers.has(review.user.login)) continue;
        core.info(`${review.user.login} has already reviewed`);
        reviewers.delete(review.user.login);
    }

    if (requestUserReviews && reviewers.size > 0) {
        core.info('Adding reviewers');
        const requestReviewersResult = await client.rest.pulls.requestReviewers({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            pull_number: github.context.issue.number,
            reviewers: Array.from(reviewers),
        }).catch((err) => {
            // Ignore the case when the owner is not a collaborator.
            // Happens in forks and when the user hasn't yet received a write bit on the repo.
            assert(err.message?.includes?.('Reviews may only be requested from collaborators'), err);
            core.info(`Ignoring error: ${util.inspect(err)}`);
            return err;
        });
        core.debug(util.inspect(requestReviewersResult));
    }
}

main().catch(err => {
    core.debug(util.inspect(err));
    core.setFailed(err.message);
});

import {Octokit as _Octokit} from "@octokit/core";
import {restEndpointMethods} from "@octokit/plugin-rest-endpoint-methods";
import {paginateGraphQL} from "@octokit/plugin-paginate-graphql";
import { throttling } from "@octokit/plugin-throttling";

import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import {createSvg} from "./github-spark.js";

async function storeDates(dates, name) {
    const datesEpochSeconds = dates.map((date) => Math.floor(date.getTime() / 1000))
    await fs.writeFile(
        name + '.bin',
        zlib.deflateSync(Uint32Array.from(datesEpochSeconds)),
    )
}

async function loadDates(name) {
    const datesEpochSeconds = await fs.readFile(name + '.bin')
        .then(buffer => Array.from(new Uint32Array(zlib.inflateSync(buffer).buffer)))
    return datesEpochSeconds.map((date) => new Date(date * 1000))
}

const Octokit = _Octokit
    .plugin(throttling)
    .plugin(restEndpointMethods)
    .plugin(paginateGraphQL);

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
    throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
            octokit.log.warn(
                `Request quota exhausted for request ${options.method} ${options.url}`,
            );

            if (retryCount < 1) {
                // only retries once
                octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                return true;
            }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
            // does not retry, only logs a warning
            octokit.log.warn(
                `SecondaryRateLimit detected for request ${options.method} ${options.url}`,
            );
        },
    },
})

// ------------------------------------------------

// gist stargazers
// const stargazersIterator = await octokit.graphql.paginate.iterator(`
//     query paginate ($owner: String!, $gist: String!, $cursor: String) {
//       user(login: $owner) {
//         repository: gist(name: $gist) {
//           stargazers(first: 100, orderBy: {field:STARRED_AT, direction: DESC}, after: $cursor) {
//             totalCount
//             edges {
//               starredAt
//             }
//             pageInfo {
//               hasNextPage
//               endCursor
//             }
//           }
//         }
//       }
//     }`, {
//         owner: 'qoomon',
//         gist: '5dfcdf8eec66a051ecd85625518cfd13',
//     }
// )


// repo stargazers
const stargazersIterator = await octokit.graphql.paginate.iterator(`
    query paginate ($owner: String!, $repo: String!, $cursor: String) {
      repositoryOwner(login: $owner) {
        repository(name: $repo) {
          stargazers(first: 100, orderBy: {field:STARRED_AT, direction: DESC}, after: $cursor) {
            totalCount
            edges {
              starredAt
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }   
      }
    }`, {
        owner: 'facebook',
        repo: 'react',
    }
)

const stargazerDates = [] // await loadDates('stargazers')
const cachedCount = stargazerDates.length
const firstCachedStarredAtDate = stargazerDates[0] || new Date(0)

try {
    for await (const response of stargazersIterator) {
        const stargazersBatch = response.repositoryOwner.repository.stargazers;
        let starredAtDates = stargazersBatch.edges.map(({starredAt}) => new Date(starredAt))
        const allFetched = starredAtDates.slice(-1)[0] <= firstCachedStarredAtDate
        if (allFetched) {
            starredAtDates = starredAtDates.filter((starredAt) => starredAt > firstCachedStarredAtDate);
        }
        stargazerDates.push(...starredAtDates);

        const stargazersToFetch = stargazersBatch.totalCount - cachedCount;
        const fetchedStargazers = stargazerDates.length - cachedCount;
        const stargazersFetchProgress = Math.round(fetchedStargazers / stargazersToFetch * 100);
        console.log('Progress: ' + stargazersFetchProgress + '%' + ' (' + fetchedStargazers + '/' + stargazersToFetch + ')')

        if (allFetched) break;
    }
} finally {
    await storeDates(stargazerDates, 'stargazers')
}

const svg = createSvg(stargazerDates)

await fs.writeFile('spark.svg', svg)

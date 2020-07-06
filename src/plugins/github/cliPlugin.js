// @flow

import Database from "better-sqlite3";
import fs from "fs-extra";
import {join as pathJoin} from "path";

import fetchGithubRepo, {fetchGithubRepoFromCache} from "./fetchGithubRepo";
import type {CacheProvider} from "../../backend/cache";
import type {CliPlugin, PluginDirectoryContext} from "../../cli/cliPlugin";
import type {PluginDeclaration} from "../../analysis/pluginDeclaration";
import type {ReferenceDetector} from "../../core/references/referenceDetector";
import {
  type WeightedGraph,
  merge as mergeWeightedGraph,
} from "../../core/weightedGraph";
import {merge as mergeWeights} from "../../core/weights";
import {RelationalView} from "./relationalView";
import {createGraph} from "./createGraph";
import {declaration} from "./declaration";
import {fromRelationalViews as referenceDetectorFromRelationalViews} from "./referenceDetector";
import {parse as parseConfig, type GithubConfig} from "./config";
import {validateToken, type GithubToken} from "./token";
import {weightsForDeclaration} from "../../analysis/pluginDeclaration";
import {type TaskReporter} from "../../util/taskReporter";
import {repoIdToString} from "./repoId";

const TOKEN_ENV_VAR_NAME = "SOURCECRED_GITHUB_TOKEN";

async function loadConfig(
  dirContext: PluginDirectoryContext
): Promise<GithubConfig> {
  const dirname = dirContext.configDirectory();
  const path = pathJoin(dirname, "config.json");
  const contents = await fs.readFile(path);
  return Promise.resolve(parseConfig(JSON.parse(contents)));
}

// Shim to interface with `fetchGithubRepo`; TODO: refactor that to just
// take a directory.
class CacheProviderImpl implements CacheProvider {
  _dirContext: PluginDirectoryContext;
  constructor(dirContext: PluginDirectoryContext) {
    this._dirContext = dirContext;
  }
  database(id: string): Promise<Database> {
    const path = pathJoin(this._dirContext.cacheDirectory(), `${id}.db`);
    return Promise.resolve(new Database(path));
  }
}

function getTokenFromEnv(): GithubToken {
  const rawToken = process.env[TOKEN_ENV_VAR_NAME];
  if (rawToken == null) {
    throw new Error(`No GitHub token provided: set ${TOKEN_ENV_VAR_NAME}`);
  }
  return validateToken(rawToken);
}

export class GithubCliPlugin implements CliPlugin {
  declaration(): PluginDeclaration {
    return declaration;
  }

  async load(
    ctx: PluginDirectoryContext,
    reporter: TaskReporter
  ): Promise<void> {
    const cache = new CacheProviderImpl(ctx);
    const token = getTokenFromEnv();
    const config = await loadConfig(ctx);
    for (const repoId of config.repoIds) {
      const repoString = repoIdToString(repoId);
      const task = `github: loading ${repoString}`;
      reporter.start(task);
      await fetchGithubRepo(repoId, {token, cache});
      reporter.finish(task);
    }
  }

  async graph(
    ctx: PluginDirectoryContext,
    rd: ReferenceDetector
  ): Promise<WeightedGraph> {
    const _ = rd; // TODO(#1808): not yet used
    const cache = new CacheProviderImpl(ctx);
    const token = getTokenFromEnv();
    const config = await loadConfig(ctx);

    const repositories = [];
    for (const repoId of config.repoIds) {
      repositories.push(await fetchGithubRepoFromCache(repoId, {token, cache}));
    }
    const wg = mergeWeightedGraph(
      repositories.map((r) => {
        const rv = new RelationalView();
        rv.addRepository(r);
        return createGraph(rv);
      })
    );
    const pluginDefaultWeights = weightsForDeclaration(declaration);
    const weights = mergeWeights([wg.weights, pluginDefaultWeights]);
    return {graph: wg.graph, weights};
  }

  async referenceDetector(
    ctx: PluginDirectoryContext
  ): Promise<ReferenceDetector> {
    const cache = new CacheProviderImpl(ctx);
    const token = getTokenFromEnv();
    const config = await loadConfig(ctx);

    const rvs = [];
    for (const repoId of config.repoIds) {
      const repo = await fetchGithubRepoFromCache(repoId, {token, cache});
      const rv = new RelationalView();
      rv.addRepository(repo);
      rvs.push(rv);
    }
    return referenceDetectorFromRelationalViews(rvs);
  }
}

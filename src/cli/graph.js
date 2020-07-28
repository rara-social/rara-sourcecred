// @flow

import fs from "fs-extra";
import sortBy from "lodash.sortby";
import stringify from "json-stable-stringify";
import {join as pathJoin} from "path";
import {loadJsonWithDefault} from "../util/disk";

import {Ledger, parser as ledgerParser} from "../ledger/ledger";
import * as NullUtil from "../util/null";
import {LoggingTaskReporter} from "../util/taskReporter";
import {type ReferenceDetector} from "../core/references/referenceDetector";
import {CascadingReferenceDetector} from "../core/references/cascadingReferenceDetector";
import type {Command} from "./command";
import {type InstanceConfig} from "../api/instanceConfig";
import {
  makePluginDir,
  loadInstanceConfig,
  pluginDirectoryContext,
} from "./common";
import {toJSON as weightedGraphToJSON} from "../core/weightedGraph";
import * as pluginId from "../api/pluginId";

function die(std, message) {
  std.err("fatal: " + message);
  return 1;
}

const graphCommand: Command = async (args, std) => {
  const taskReporter = new LoggingTaskReporter();
  taskReporter.start("graph");
  const baseDir = process.cwd();
  const config: InstanceConfig = await loadInstanceConfig(baseDir);

  let pluginsToLoad = [];
  if (args.length === 0) {
    pluginsToLoad = config.bundledPlugins.keys();
  } else {
    for (const arg of args) {
      const id = pluginId.fromString(arg);
      if (config.bundledPlugins.has(id)) {
        pluginsToLoad.push(id);
      } else {
        return die(
          std,
          `can't find plugin ${id}; remember to use fully scoped name, as in sourcecred/github`
        );
      }
    }
  }

  const graphOutputPrefix = ["output", "graphs"];

  const rd = await buildReferenceDetector(baseDir, config, taskReporter);
  for (const name of pluginsToLoad) {
    const plugin = NullUtil.get(config.bundledPlugins.get(name));
    const task = `${name}: generating graph`;
    taskReporter.start(task);
    const dirContext = pluginDirectoryContext(baseDir, name);
    const graph = await plugin.graph(dirContext, rd, taskReporter);
    const serializedGraph = stringify(weightedGraphToJSON(graph));
    const outputDir = makePluginDir(baseDir, graphOutputPrefix, name);
    const outputPath = pathJoin(outputDir, "graph.json");
    await fs.writeFile(outputPath, serializedGraph);
    taskReporter.finish(task);
  }
  taskReporter.finish("graph");
  return 0;
};

async function buildReferenceDetector(baseDir, config, taskReporter) {
  taskReporter.start("reference detector");
  const rds = [];
  for (const [name, plugin] of sortBy(
    [...config.bundledPlugins],
    ([k, _]) => k
  )) {
    const dirContext = pluginDirectoryContext(baseDir, name);
    const task = `reference detector for ${name}`;
    taskReporter.start(task);
    const rd = await plugin.referenceDetector(dirContext, taskReporter);
    rds.push(rd);
    taskReporter.finish(task);
  }
  taskReporter.finish("reference detector");
  rds.push(await makeHackyIdentityNameReferenceDetector(baseDir));
  return new CascadingReferenceDetector(rds);
}

async function makeHackyIdentityNameReferenceDetector(
  baseDir
): Promise<ReferenceDetector> {
  // Hack to support old-school (deprecated) "initiatives files":
  // We need to be able to parse references to usernames, e.g. "@yalor", so
  // we need a reference detector that will match these to identities in the
  // Ledger. This isn't a robust addressing scheme, since identities are re-nameable;
  // in v2 the initiatives plugin will be re-written to use identity node addresses instead.
  // This hack can be safely deleted once we no longer support initiatives files that refer
  // to identities by their names instead of their IDs.
  const ledgerPath = pathJoin(baseDir, "data", "ledger.json");
  const ledger = await loadJsonWithDefault(
    ledgerPath,
    ledgerParser,
    () => new Ledger()
  );
  return _hackyIdentityNameReferenceDetector(ledger);
}

export function _hackyIdentityNameReferenceDetector(
  ledger: Ledger
): ReferenceDetector {
  const usernameToAddress = new Map(
    ledger.accounts().map((a) => [a.identity.name, a.identity.address])
  );
  function addressFromUrl(potentialUsername: string) {
    const prepped = potentialUsername.replace("@", "").toLowerCase();
    return usernameToAddress.get(prepped);
  }
  return {addressFromUrl};
}

export default graphCommand;

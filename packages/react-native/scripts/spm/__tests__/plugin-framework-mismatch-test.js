/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @noflow
 */

'use strict';

const {PLUGIN_FRAMEWORKS_MANIFEST} = require('../flavored-frameworks');
const {
  PluginFrameworkMismatchError,
  SPM_INJECTED_MARKER,
  assertPluginFrameworksLinked,
  injectSpmIntoExistingXcodeproj,
} = require('../generate-spm-xcodeproj');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLAIN = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'plain-app.pbxproj'),
  'utf8',
);

function frameworkEntry(id, frameworkName, artifactRelativePath) {
  return {
    id,
    frameworkName,
    executableName: frameworkName,
    linkage: 'dynamic',
    artifactRelativePath,
    slices: [
      {
        sdk: 'iphoneos*',
        platform: 'ios',
        variant: null,
        architectures: ['arm64'],
        libraryIdentifier: 'ios-arm64',
        libraryPath: `${frameworkName}.framework`,
        binaryPath: `${frameworkName}.framework/${frameworkName}`,
      },
    ],
  };
}

const REACT = frameworkEntry('react', 'React', 'React.xcframework');
const HERMES = frameworkEntry('hermes', 'hermes', 'hermes-engine.xcframework');
const EXPO = frameworkEntry(
  'expo-core',
  'ExpoCore',
  'plugins/expo-core.xcframework',
);

let appRoots = [];
let errorSpy;

beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const appRoot of appRoots) {
    fs.rmSync(appRoot, {recursive: true, force: true});
  }
  appRoots = [];
});

function scaffoldApp() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-plugin-check-'));
  appRoots.push(appRoot);
  const xcodeprojPath = path.join(appRoot, 'MyApp.xcodeproj');
  fs.mkdirSync(xcodeprojPath, {recursive: true});
  fs.writeFileSync(path.join(xcodeprojPath, 'project.pbxproj'), PLAIN);
  const rnRoot = path.join(appRoot, 'node_modules', 'react-native');
  fs.mkdirSync(rnRoot, {recursive: true});
  const artifactRoot = path.join(appRoot, 'build', 'xcframeworks');
  fs.mkdirSync(artifactRoot, {recursive: true});
  fs.writeFileSync(path.join(artifactRoot, '.artifact-stamp'), 'test\n');
  return {appRoot, xcodeprojPath, rnRoot};
}

// What `spm add` / `spm update` would have linked.
function inject({appRoot, xcodeprojPath, rnRoot}, frameworks) {
  fs.writeFileSync(
    path.join(appRoot, 'build', 'xcframeworks', 'flavored-frameworks.json'),
    JSON.stringify({version: 1, frameworks}),
  );
  injectSpmIntoExistingXcodeproj({
    appRoot,
    reactNativeRoot: rnRoot,
    xcodeprojPath,
  });
}

// What the build-time sync's plugins pair on this machine.
function writeSidecar(appRoot, frameworks) {
  const sidecarPath = path.join(appRoot, PLUGIN_FRAMEWORKS_MANIFEST);
  fs.mkdirSync(path.dirname(sidecarPath), {recursive: true});
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify(
      frameworks.map(({id, frameworkName}) => ({
        id,
        frameworkName,
        linkage: 'dynamic',
        flavors: {
          debug: `/plugins/debug/${frameworkName}.xcframework`,
          release: `/plugins/release/${frameworkName}.xcframework`,
        },
      })),
    ),
  );
}

function projectFiles(xcodeprojPath) {
  return ['project.pbxproj', SPM_INJECTED_MARKER].map(name => {
    const file = path.join(xcodeprojPath, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  });
}

// Runs the check and proves it wrote neither the pbxproj nor the marker.
// Returns the printed lines and the thrown error, if any.
function check(app, env = {}) {
  const before = projectFiles(app.xcodeprojPath);
  let error = null;
  try {
    assertPluginFrameworksLinked(app.appRoot, env);
  } catch (e) {
    error = e;
  }
  expect(projectFiles(app.xcodeprojPath)).toEqual(before);
  return {error, lines: errorSpy.mock.calls.map(call => call.join(' '))};
}

describe('assertPluginFrameworksLinked', () => {
  it('fails when a plugin pairs a framework the project does not link', () => {
    const app = scaffoldApp();
    inject(app, [REACT]);
    writeSidecar(app.appRoot, [EXPO]);

    const {error, lines} = check(app);

    expect(error).toBeInstanceOf(PluginFrameworkMismatchError);
    expect(lines).toEqual([
      'error: ExpoCore (expo-core) is a precompiled framework from an autolinking plugin, but the Xcode project does not link it. Run `npx react-native spm` to update the project.',
    ]);
  });

  it('fails when the project links a plugin framework no plugin provides', () => {
    const app = scaffoldApp();
    inject(app, [REACT, EXPO]);
    writeSidecar(app.appRoot, []);

    const {error, lines} = check(app);

    expect(error).toBeInstanceOf(PluginFrameworkMismatchError);
    expect(lines).toEqual([
      'error: The Xcode project links ExpoCore.framework, but no autolinking plugin provides it on this machine. Precompile ExpoCore, or run `npx react-native spm` to update the project.',
    ]);
  });

  it('fails when a plugin renames its framework but keeps its id', () => {
    const app = scaffoldApp();
    inject(app, [REACT, EXPO]);
    writeSidecar(app.appRoot, [{id: 'expo-core', frameworkName: 'NewCore'}]);

    const {error, lines} = check(app);

    expect(error).toBeInstanceOf(PluginFrameworkMismatchError);
    expect(lines).toEqual([
      'error: NewCore (expo-core) is a precompiled framework from an autolinking plugin, but the Xcode project does not link it. Run `npx react-native spm` to update the project.',
      'error: The Xcode project links ExpoCore.framework, but no autolinking plugin provides it on this machine. Precompile ExpoCore, or run `npx react-native spm` to update the project.',
    ]);
  });

  it('checks the project Xcode is building, not the first injected one', () => {
    const app = scaffoldApp();
    const stale = {
      ...app,
      xcodeprojPath: path.join(app.appRoot, 'A.xcodeproj'),
    };
    fs.mkdirSync(stale.xcodeprojPath);
    fs.writeFileSync(path.join(stale.xcodeprojPath, 'project.pbxproj'), PLAIN);
    inject(stale, [REACT]);
    inject(app, [REACT, EXPO]);
    writeSidecar(app.appRoot, [EXPO]);

    expect(check(app, {PROJECT_FILE_PATH: app.xcodeprojPath})).toEqual({
      error: null,
      lines: [],
    });
  });

  it('passes when the project links exactly the paired plugin frameworks', () => {
    const app = scaffoldApp();
    inject(app, [REACT, HERMES, EXPO]);
    writeSidecar(app.appRoot, [EXPO]);

    expect(check(app)).toEqual({error: null, lines: []});
  });

  it('reads framework names that contain a space', () => {
    const app = scaffoldApp();
    const spaced = frameworkEntry('my-fw', 'My Fw', 'My Fw.xcframework');
    inject(app, [REACT, HERMES, spaced]);
    writeSidecar(app.appRoot, [spaced]);

    expect(check(app)).toEqual({error: null, lines: []});
  });

  it('compares only setting prefixes when the frameworks manifest is missing', () => {
    const app = scaffoldApp();
    inject(app, [REACT, HERMES, EXPO]);
    writeSidecar(app.appRoot, [EXPO]);
    fs.rmSync(
      path.join(app.appRoot, 'build/xcframeworks/flavored-frameworks.json'),
    );

    expect(check(app)).toEqual({error: null, lines: []});
  });

  it('skips a project that was never injected', () => {
    const app = scaffoldApp();
    writeSidecar(app.appRoot, [EXPO]);

    expect(check(app)).toEqual({error: null, lines: []});
  });

  it('skips a project without the embed phase', () => {
    const app = scaffoldApp();
    inject(app, [REACT]);
    writeSidecar(app.appRoot, [EXPO]);
    fs.writeFileSync(path.join(app.xcodeprojPath, 'project.pbxproj'), PLAIN);

    expect(check(app)).toEqual({error: null, lines: []});
  });
});

it('injects a plugin framework idempotently', () => {
  const app = scaffoldApp();
  inject(app, [REACT, EXPO]);
  const pbxprojPath = path.join(app.xcodeprojPath, 'project.pbxproj');
  const once = fs.readFileSync(pbxprojPath, 'utf8');

  inject(app, [REACT, EXPO]);

  expect(fs.readFileSync(pbxprojPath, 'utf8')).toBe(once);
});

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const [version, repository] = process.argv.slice(2);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/prepare-swift-release.mjs <version> <owner/repository>');
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
  throw new Error('Repository must be an owner/repository slug.');
}

const framework = resolve(root, 'apple/MDECore.xcframework');
if (!existsSync(framework)) {
  throw new Error('apple/MDECore.xcframework is missing; run ./scripts/build-rust.sh first.');
}

const archiveName = `MDECore-${version}.xcframework.zip`;
const archive = resolve(root, 'apple', archiveName);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', framework, archive]);
const checksum = run('swift', ['package', 'compute-checksum', archive]);
const assetUrl = `https://github.com/${repository}/releases/download/swift-v${version}/${archiveName}`;

const manifest = `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MDEditor",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MDECore", targets: ["MDECore"]),
        .library(name: "MDEPluginKit", targets: ["MDEPluginKit"]),
        .library(name: "MDEditorUI", targets: ["MDEditorUI"]),
        .library(name: "MDEHost", targets: ["MDEHost"]),
    ],
    targets: [
        .binaryTarget(
            name: "CMDE",
            url: "${assetUrl}",
            checksum: "${checksum}"
        ),
        .target(name: "MDECore", dependencies: ["CMDE"], path: "apple/Sources/MDECore"),
        .target(
            name: "MDEPluginKit",
            dependencies: ["MDECore"],
            path: "apple/Sources/MDEPluginKit"
        ),
        .target(
            name: "MDEditorUI",
            dependencies: ["MDECore", "MDEPluginKit"],
            path: "apple/Sources/MDEditorUI"
        ),
        .target(
            name: "MDEHost",
            dependencies: ["MDECore", "MDEPluginKit", "MDEditorUI"],
            path: "apple/Sources/MDEHost"
        ),
    ]
)
`;

writeFileSync(resolve(root, 'Package.swift'), manifest);
console.log(`Created Package.swift for swift-v${version}`);
console.log(`Archive: ${archive}`);
console.log(`Checksum: ${checksum}`);
console.log(`Upload URL: ${assetUrl}`);

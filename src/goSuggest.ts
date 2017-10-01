/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import cp = require('child_process');
import path = require('path');
import { getBinPath, parameters, parseFilePrelude, isPositionInString, goKeywords, getToolsEnvVars, guessPackageNameFromFile, getGoVersion, SemVersion, getCurrentGoPath } from './util';
import { promptForMissingTool } from './goInstallTools';
import { getTextEditForAddImport } from './goImport';
import { getImportablePackages } from './goPackages';
import { getCurrentGoWorkspaceFromGOPATH} from './goPath';

function vscodeKindFromGoCodeClass(kind: string): vscode.CompletionItemKind {
	switch (kind) {
		case 'const':
		case 'package':
		case 'type':
			return vscode.CompletionItemKind.Keyword;
		case 'func':
			return vscode.CompletionItemKind.Function;
		case 'var':
			return vscode.CompletionItemKind.Field;
		case 'import':
			return vscode.CompletionItemKind.Module;
	}
	return vscode.CompletionItemKind.Property; // TODO@EG additional mappings needed?
}

interface GoCodeSuggestion {
	class: string;
	name: string;
	type: string;
}

export class GoCompletionItemProvider implements vscode.CompletionItemProvider {

	private pkgsList = new Map<string, string>();
	private goVersion: SemVersion;

	public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Thenable<vscode.CompletionItem[]> {
		return this.provideCompletionItemsInternal(document, position, token, vscode.workspace.getConfiguration('go', document.uri));
	}

	public provideCompletionItemsInternal(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, config: vscode.WorkspaceConfiguration): Thenable<vscode.CompletionItem[]> {
		return this.ensureGoCodeConfigured().then(() => {
			return new Promise<vscode.CompletionItem[]>((resolve, reject) => {
				let filename = document.fileName;
				let lineText = document.lineAt(position.line).text;
				let lineTillCurrentPosition = lineText.substr(0, position.character);
				let autocompleteUnimportedPackages = config['autocompleteUnimportedPackages'] === true && !lineText.match(/^(\s)*(import|package)(\s)+/);

				if (lineText.match(/^\s*\/\//)) {
					return resolve([]);
				}

				let inString = isPositionInString(document, position);
				if (!inString && lineTillCurrentPosition.endsWith('\"')) {
					return resolve([]);
				}

				// get current word
				let wordAtPosition = document.getWordRangeAtPosition(position);
				let currentWord = '';
				if (wordAtPosition && wordAtPosition.start.character < position.character) {
					let word = document.getText(wordAtPosition);
					currentWord = word.substr(0, position.character - wordAtPosition.start.character);
				}

				if (currentWord.match(/^\d+$/)) {
					return resolve([]);
				}

				let offset = document.offsetAt(position);
				let inputText = document.getText();
				let includeUnimportedPkgs = autocompleteUnimportedPackages && !inString;

				return this.runGoCode(filename, inputText, offset, inString, position, lineText, currentWord, includeUnimportedPkgs).then(suggestions => {
					// gocode does not suggest keywords, so we have to do it
					if (currentWord.length > 0) {
						goKeywords.forEach(keyword => {
							if (keyword.startsWith(currentWord)) {
								suggestions.push(new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword));
							}
						});
					}

					// If no suggestions and cursor is at a dot, then check if preceeding word is a package name
					// If yes, then import the package in the inputText and run gocode again to get suggestions
					if (suggestions.length === 0 && lineTillCurrentPosition.endsWith('.')) {

						let pkgPath = this.getPackagePathFromLine(filename, lineTillCurrentPosition);
						if (pkgPath) {
							// Now that we have the package path, import it right after the "package" statement
							let { imports, pkg } = parseFilePrelude(vscode.window.activeTextEditor.document.getText());
							let posToAddImport = document.offsetAt(new vscode.Position(pkg.start + 1, 0));
							let textToAdd = `import "${pkgPath}"\n`;
							inputText = inputText.substr(0, posToAddImport) + textToAdd + inputText.substr(posToAddImport);
							offset += textToAdd.length;

							// Now that we have the package imported in the inputText, run gocode again
							return this.runGoCode(filename, inputText, offset, inString, position, lineText, currentWord, false).then(newsuggestions => {
								// Since the new suggestions are due to the package that we imported,
								// add additionalTextEdits to do the same in the actual document in the editor
								// We use additionalTextEdits instead of command so that 'useCodeSnippetsOnFunctionSuggest' feature continues to work
								newsuggestions.forEach(item => {
									item.additionalTextEdits = [getTextEditForAddImport(pkgPath)];
								});
								resolve(newsuggestions);
							});
						}
					}
					resolve(suggestions);
				});
			});
		});
	}

	private runGoCode(filename: string, inputText: string, offset: number, inString: boolean, position: vscode.Position, lineText: string, currentWord: string, includeUnimportedPkgs: boolean): Thenable<vscode.CompletionItem[]> {
		return new Promise<vscode.CompletionItem[]>((resolve, reject) => {
			let gocode = getBinPath('gocode');

			// Unset GOOS and GOARCH for the `gocode` process to ensure that GOHOSTOS and GOHOSTARCH
			// are used as the target operating system and architecture. `gocode` is unable to provide
			// autocompletion when the Go environment is configured for cross compilation.
			let env = Object.assign({}, getToolsEnvVars(), { GOOS: '', GOARCH: '' });
			let stdout = '';
			let stderr = '';

			// Spawn `gocode` process
			let p = cp.spawn(gocode, ['-f=json', 'autocomplete', filename, 'c' + offset], { env });
			p.stdout.on('data', data => stdout += data);
			p.stderr.on('data', data => stderr += data);
			p.on('error', err => {
				if (err && (<any>err).code === 'ENOENT') {
					promptForMissingTool('gocode');
					return reject();
				}
				return reject(err);
			});
			p.on('close', code => {
				try {
					if (code !== 0) {
						return reject(stderr);
					}
					let results = <[number, GoCodeSuggestion[]]>JSON.parse(stdout.toString());
					let suggestions = [];
					let suggestionSet = new Set<string>();

					if (results[1]) {
						for (let suggest of results[1]) {
							if (inString && suggest.class !== 'import') continue;
							let item = new vscode.CompletionItem(suggest.name);
							item.kind = vscodeKindFromGoCodeClass(suggest.class);
							item.detail = suggest.type;
							if (inString && suggest.class === 'import') {
								item.textEdit = new vscode.TextEdit(
									new vscode.Range(
										position.line,
										lineText.substring(0, position.character).lastIndexOf('"') + 1,
										position.line,
										position.character),
									suggest.name
								);
							}
							let conf = vscode.workspace.getConfiguration('go', vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null);
							if ((conf.get('useCodeSnippetsOnFunctionSuggest') || conf.get('useCodeSnippetsOnFunctionSuggestWithoutType')) && suggest.class === 'func') {
								let params = parameters(suggest.type.substring(4));
								let paramSnippets = [];
								for (let i = 0; i < params.length; i++) {
									let param = params[i].trim();
									if (param) {
										param = param.replace('${', '\\${').replace('}', '\\}');
										if (conf.get('useCodeSnippetsOnFunctionSuggestWithoutType')) {
											param = param.substr(0, param.indexOf(' '));
										}
										paramSnippets.push('${' + (i + 1) + ':' + param + '}');
									}
								}
								item.insertText = new vscode.SnippetString(suggest.name + '(' + paramSnippets.join(', ') + ')');
							}

							// Add same sortText to all suggestions from gocode so that they appear before the unimported packages
							item.sortText = 'a';
							suggestions.push(item);
							suggestionSet.add(item.label);
						};
					}

					// Add importable packages matching currentword to suggestions
					let importablePkgs = includeUnimportedPkgs ? this.getMatchingPackages(filename, currentWord, suggestionSet) : [];
					suggestions = suggestions.concat(importablePkgs);

					// 'Smart Snippet' for package clause
					// TODO: Factor this out into a general mechanism
					if (!inputText.match(/package\s+(\w+)/)) {
						return guessPackageNameFromFile(filename).then(pkgName => {
							let packageItem = new vscode.CompletionItem('package ' + pkgName);
							packageItem.kind = vscode.CompletionItemKind.Snippet;
							packageItem.insertText = 'package ' + pkgName + '\r\n\r\n';
							suggestions.push(packageItem);
							resolve(suggestions);
						}, () => resolve(suggestions));
					}

					resolve(suggestions);
				} catch (e) {
					reject(e);
				}
			});
			p.stdin.end(inputText);
		});
	}
	// TODO: Shouldn't lib-path also be set?
	private ensureGoCodeConfigured(): Thenable<void> {
		let importablePkgsPromise = getImportablePackages(vscode.window.activeTextEditor.document.fileName).then(pkgMap => this.pkgsList = pkgMap);
		let goVersionPromise = getGoVersion().then((version: SemVersion) => {
			console.log('Go Version:', version);
			this.goVersion = version;
		});
		// let setPkgsList = Promise.race([timeout(1000).then(() => this.pkgsList), importablePkgsPromise]);

		let setGocodeProps = new Promise<void>((resolve, reject) => {
			let gocode = getBinPath('gocode');
			let autobuild = vscode.workspace.getConfiguration('go', vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null)['gocodeAutoBuild'];
			let env = getToolsEnvVars();
			cp.execFile(gocode, ['set', 'propose-builtins', 'true'], { env }, (err, stdout, stderr) => {
				cp.execFile(gocode, ['set', 'autobuild', autobuild], {}, (err, stdout, stderr) => {
					return resolve();
				});
			});
		});
		// return setGocodeProps;
		// return Promise.all([setPkgsList, setGocodeProps]).then(() => {
		// 	return;
		// });
		return Promise.all([setGocodeProps, goVersionPromise]).then(() => {
			return;
		});
	}

	// Return importable packages that match given word as Completion Items
	private getMatchingPackages(filename: string, word: string, suggestionSet: Set<string>): vscode.CompletionItem[] {
		if (!word) return [];
		let completionItems = [];

		this.getPkgsList(filename).forEach((pkgName: string, pkgPath: string) => {
			if (pkgName.startsWith(word) && !suggestionSet.has(pkgName)) {

				let item = new vscode.CompletionItem(pkgName, vscode.CompletionItemKind.Keyword);
				item.detail = pkgPath;
				item.documentation = 'Imports the package';
				item.insertText = pkgName;
				item.command = {
					title: 'Import Package',
					command: 'go.import.add',
					arguments: [pkgPath]
				};
				// Add same sortText to the unimported packages so that they appear after the suggestions from gocode
				item.sortText = 'z';
				completionItems.push(item);
			}
		});
		return completionItems;
	}

	// Given a line ending with dot, return the word preceeding the dot if it is a package name that can be imported
	private getPackagePathFromLine(filename: string, line: string): string {
		let pattern = /(\w+)\.$/g;
		let wordmatches = pattern.exec(line);
		if (!wordmatches) {
			return;
		}

		let [_, pkgNameFromWord] = wordmatches;
		// Word is isolated. Now check pkgsList for a match
		let matchingPackages = [];
		this.getPkgsList(filename).forEach((pkgName: string, pkgPath: string) => {
			if (pkgNameFromWord === pkgName) {
				matchingPackages.push(pkgPath);
			}
		});

		if (matchingPackages && matchingPackages.length === 1) {
			return matchingPackages[0];
		}
	}

	private getPkgsList(filename: string): Map<string, string> {
		let filtered = new Map<string, string>();
		let fileDirPath = path.dirname(filename);
		let currentWorkspace = getCurrentGoWorkspaceFromGOPATH(getCurrentGoPath(), fileDirPath);
		this.pkgsList.forEach((pkgName, pkgPath) => {
			let allowToImport = isAllowToImportPackage(fileDirPath, currentWorkspace, pkgPath, this.goVersion);
			if (allowToImport) {
				filtered.set(pkgPath, pkgName);
			}
		});
		return filtered;
	}
}

// This will check whether it's regular package or internal package
// Regular package will always allowed
// Internal package only allowed if the package doing the import is within the tree rooted at the parent of "internal" directory
// see: https://golang.org/doc/go1.4#internalpackages
// see: https://golang.org/s/go14internal
function isAllowToImportPackage(toDirPath: string, currentWorkspace: string, pkgPath: string, goVersion: SemVersion) {
	if (toDirPath === path.join(currentWorkspace, pkgPath)) {
		// cannot import it's own package
		return false;
	}

	if (goVersion.major < 1 || goVersion.major === 1 && goVersion.minor < 4) {
		return true;
	}

	let internalPkgFound = pkgPath.match(/\/internal\/|\/internal$/);
	if (internalPkgFound) {
		let rootProjectForInternalPkg = path.join(currentWorkspace, pkgPath.substr(0, internalPkgFound.index));
		return toDirPath.startsWith(rootProjectForInternalPkg);
	}
	return true;
}

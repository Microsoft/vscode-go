/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import os = require('os');
import semver = require('semver');
import vscode = require('vscode');
import WebRequest = require('web-request');
import path = require('path');
import cp = require('child_process');
import {
	LanguageClient, RevealOutputChannelOn, FormattingOptions, ProvideDocumentFormattingEditsSignature,
	ProvideCompletionItemsSignature, ProvideRenameEditsSignature, ProvideDefinitionSignature, ProvideHoverSignature,
	ProvideReferencesSignature, ProvideSignatureHelpSignature, ProvideDocumentSymbolsSignature, ProvideWorkspaceSymbolsSignature,
	HandleDiagnosticsSignature, ProvideDocumentLinksSignature,
} from 'vscode-languageclient';
import { ProvideTypeDefinitionSignature } from 'vscode-languageclient/lib/typeDefinition';
import { ProvideImplementationSignature } from 'vscode-languageclient/lib/implementation';
import { GO_MODE } from './goMode';
import { getToolFromToolPath } from './goPath';
import { getToolsEnvVars } from './util';
import { GoCompletionItemProvider } from './goSuggest';
import { GoHoverProvider } from './goExtraInfo';
import { GoDefinitionProvider } from './goDeclaration';
import { GoReferenceProvider } from './goReferences';
import { GoImplementationProvider } from './goImplementations';
import { GoTypeDefinitionProvider } from './goTypeDefinition';
import { GoDocumentFormattingEditProvider } from './goFormat';
import { GoRenameProvider } from './goRename';
import { GoDocumentSymbolProvider } from './goOutline';
import { GoSignatureHelpProvider } from './goSignature';
import { GoWorkspaceSymbolProvider } from './goSymbol';
import { parseLiveFile } from './goLiveErrors';
import { promptForMissingTool, promptForUpdatingTool } from './goInstallTools';
import { getBinPath, getCurrentGoPath } from './util';
import { Tool, getTool } from './goTools';

interface LanguageServerConfig {
	enabled: boolean;
	flags: string[];
	features: {
		completion: boolean;
		diagnostics: boolean;
		format: boolean;
		definition: boolean;
		typeDefinition: boolean;
		hover: boolean;
		references: boolean;
		rename: boolean;
		signatureHelp: boolean;
		documentSymbols: boolean;
		workspaceSymbols: boolean;
		implementation: boolean;
		documentLink: boolean;
	};
}

// registerLanguageFeatures registers providers for all the language features.
// It looks to either the language server or the standard providers for these features.
export async function registerLanguageFeatures(ctx: vscode.ExtensionContext) {
	// Subscribe to notifications for changes to the configuration of the language server.
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => watchLanguageServerConfiguration(e)));

	const config = parseLanguageServerConfig();

	// If the user has not enabled the language server,
	// register the default language features and return.
	if (!config.enabled) {
		registerUsualProviders(ctx);
		return;
	}

	// The user has opted into the language server.
	const path = getLanguageServerToolPath();
	const toolName = getToolFromToolPath(path);

	// The user may not have the most up-to-date version of the language server.
	const tool = getTool(toolName);
	if (await shouldUpdateLanguageServer(tool, path)) {
		promptForUpdatingTool(toolName);
	}

	const c = new LanguageClient(
		toolName,
		{
			command: path,
			args: ['-mode=stdio', ...config.flags],
			options: {
				env: getToolsEnvVars(),
			},
		},
		{
			initializationOptions: {},
			documentSelector: ['go', 'go.mod', 'go.sum'],
			uriConverters: {
				// Apply file:/// scheme to all file paths.
				code2Protocol: (uri: vscode.Uri): string => (uri.scheme ? uri : uri.with({ scheme: 'file' })).toString(),
				protocol2Code: (uri: string) => vscode.Uri.parse(uri),
			},
			revealOutputChannelOn: RevealOutputChannelOn.Never,
			middleware: {
				provideDocumentFormattingEdits: (document: vscode.TextDocument, options: FormattingOptions, token: vscode.CancellationToken, next: ProvideDocumentFormattingEditsSignature) => {
					if (!config.features.format) {
						return [];
					}
					return next(document, options, token);
				},
				provideCompletionItem: async (document: vscode.TextDocument, position: vscode.Position, context: vscode.CompletionContext, token: vscode.CancellationToken, next: ProvideCompletionItemsSignature) => {
					if (!config.features.completion) {
						return [];
					}
					return next(document, position, context, token);
				},
				provideRenameEdits: (document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken, next: ProvideRenameEditsSignature) => {
					if (!config.features.rename) {
						return null;
					}
					return next(document, position, newName, token);
				},
				provideDefinition: (document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, next: ProvideDefinitionSignature) => {
					if (!config.features.definition) {
						return null;
					}
					return next(document, position, token);
				},
				provideTypeDefinition: (document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, next: ProvideTypeDefinitionSignature) => {
					if (!config.features.typeDefinition) {
						return null;
					}
					return next(document, position, token);
				},
				provideHover: (document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, next: ProvideHoverSignature) => {
					if (!config.features.hover) {
						return null;
					}
					return next(document, position, token);
				},
				provideReferences: (document: vscode.TextDocument, position: vscode.Position, options: { includeDeclaration: boolean }, token: vscode.CancellationToken, next: ProvideReferencesSignature) => {
					if (!config.features.references) {
						return [];
					}
					return next(document, position, options, token);
				},
				provideSignatureHelp: (document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, next: ProvideSignatureHelpSignature) => {
					if (!config.features.signatureHelp) {
						return null;
					}
					return next(document, position, token);
				},
				provideDocumentSymbols: (document: vscode.TextDocument, token: vscode.CancellationToken, next: ProvideDocumentSymbolsSignature) => {
					if (!config.features.documentSymbols) {
						return [];
					}
					return next(document, token);
				},
				provideWorkspaceSymbols: (query: string, token: vscode.CancellationToken, next: ProvideWorkspaceSymbolsSignature) => {
					if (!config.features.workspaceSymbols) {
						return [];
					}
					return next(query, token);
				},
				provideImplementation: (document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, next: ProvideImplementationSignature) => {
					if (!config.features.implementation) {
						return null;
					}
					return next(document, position, token);
				},
				handleDiagnostics: (uri: vscode.Uri, diagnostics: vscode.Diagnostic[], next: HandleDiagnosticsSignature) => {
					if (!config.features.diagnostics) {
						return null;
					}
					return next(uri, diagnostics);
				},
				provideDocumentLinks: (document: vscode.TextDocument, token: vscode.CancellationToken, next: ProvideDocumentLinksSignature) => {
					if (!config.features.documentLink) {
						return null;
					}
					return next(document, token);
				}
			}
		}
	);

	c.onReady().then(() => {
		const capabilities = c.initializeResult && c.initializeResult.capabilities;
		if (!capabilities) {
			return vscode.window.showErrorMessage('The language server is not able to serve any features at the moment.');
		}

		// Fallback to default providers for unsupported or disabled features.

		if (!config.features.completion || !capabilities.completionProvider) {
			const provider = new GoCompletionItemProvider(ctx.globalState);
			ctx.subscriptions.push(provider);
			ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(GO_MODE, provider, '.', '\"'));
		}

		if (!config.features.format || !capabilities.documentFormattingProvider) {
			ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(GO_MODE, new GoDocumentFormattingEditProvider()));
		}

		if (!config.features.rename || !capabilities.renameProvider) {
			ctx.subscriptions.push(vscode.languages.registerRenameProvider(GO_MODE, new GoRenameProvider()));
		}

		if (!config.features.typeDefinition || !capabilities.typeDefinitionProvider) {
			ctx.subscriptions.push(vscode.languages.registerTypeDefinitionProvider(GO_MODE, new GoTypeDefinitionProvider()));
		}

		if (!config.features.hover || !capabilities.hoverProvider) {
			ctx.subscriptions.push(vscode.languages.registerHoverProvider(GO_MODE, new GoHoverProvider()));
		}

		if (!config.features.definition || !capabilities.definitionProvider) {
			ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(GO_MODE, new GoDefinitionProvider()));
		}

		if (!config.features.references || !capabilities.referencesProvider) {
			ctx.subscriptions.push(vscode.languages.registerReferenceProvider(GO_MODE, new GoReferenceProvider()));
		}

		if (!config.features.documentSymbols || !capabilities.documentSymbolProvider) {
			ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(GO_MODE, new GoDocumentSymbolProvider()));
		}

		if (!config.features.signatureHelp || !capabilities.signatureHelpProvider) {
			ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(GO_MODE, new GoSignatureHelpProvider(), '(', ','));
		}

		if (!config.features.workspaceSymbols || !capabilities.workspaceSymbolProvider) {
			ctx.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(new GoWorkspaceSymbolProvider()));
		}

		if (!config.features.implementation || !capabilities.implementationProvider) {
			ctx.subscriptions.push(vscode.languages.registerImplementationProvider(GO_MODE, new GoImplementationProvider()));
		}
	});

	let languageServerDisposable = c.start();
	ctx.subscriptions.push(languageServerDisposable);

	ctx.subscriptions.push(vscode.commands.registerCommand('go.languageserver.restart', async () => {
		await c.stop();
		languageServerDisposable.dispose();
		languageServerDisposable = c.start();
		ctx.subscriptions.push(languageServerDisposable);
	}));

	// gopls is the only language server that provides live diagnostics on type,
	// so use gotype if it's not enabled.
	if (!(toolName === 'gopls' && config.features['diagnostics'])) {
		vscode.workspace.onDidChangeTextDocument(parseLiveFile, null, ctx.subscriptions);
	}
}

function watchLanguageServerConfiguration(e: vscode.ConfigurationChangeEvent) {
	if (!e.affectsConfiguration('go')) {
		return;
	}

	const config = parseLanguageServerConfig();
	let reloadMessage: string;

	// If the user has disabled or enabled the language server.
	if (e.affectsConfiguration('go.useLanguageServer')) {
		if (config.enabled) {
			reloadMessage = 'Reload VS Code window to enable the use of language server';
		} else {
			reloadMessage = 'Reload VS Code window to disable the use of language server';
		}
	}

	if (e.affectsConfiguration('go.languageServerFlags') || e.affectsConfiguration('go.languageServerExperimentalFeatures')) {
		reloadMessage = 'Reload VS Code window for the changes in language server settings to take effect';
	}

	// If there was a change in the configuration of the language server,
	// then ask the user to reload VS Code.
	if (reloadMessage) {
		vscode.window.showInformationMessage(reloadMessage, 'Reload').then(selected => {
			if (selected === 'Reload') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	}
}

export function parseLanguageServerConfig(): LanguageServerConfig {
	const goConfig = vscode.workspace.getConfiguration('go');

	const config = {
		enabled: goConfig['useLanguageServer'],
		flags: goConfig['languageServerFlags'] || [],
		features: {
			// TODO: We should have configs that match these names.
			// Ultimately, we should have a centralized language server config rather than separate fields.
			completion: goConfig['languageServerExperimentalFeatures']['autoComplete'],
			diagnostics: goConfig['languageServerExperimentalFeatures']['diagnostics'],
			format: goConfig['languageServerExperimentalFeatures']['format'],
			definition: goConfig['languageServerExperimentalFeatures']['goToDefinition'],
			typeDefinition: goConfig['languageServerExperimentalFeatures']['goToTypeDefinition'],
			hover: goConfig['languageServerExperimentalFeatures']['hover'],
			references: goConfig['languageServerExperimentalFeatures']['findReferences'],
			rename: goConfig['languageServerExperimentalFeatures']['rename'],
			signatureHelp: goConfig['languageServerExperimentalFeatures']['signatureHelp'],
			documentSymbols: goConfig['languageServerExperimentalFeatures']['documentSymbols'],
			workspaceSymbols: goConfig['languageServerExperimentalFeatures']['workspaceSymbols'],
			implementation: goConfig['languageServerExperimentalFeatures']['implementation'],
			documentLink: goConfig['languageServerExperimentalFeatures']['documentLink'],
		},
	};
	return config;
}

/**
 * Get the absolute path to the language server to be used.
 * If the required tool is not available, then user is prompted to install it.
 * This supports the language servers from both Google and Sourcegraph with the
 * former getting a precedence over the latter
 */
export function getLanguageServerToolPath(): string {
	// If language server is not enabled, return
	const goConfig = vscode.workspace.getConfiguration('go');
	if (!goConfig['useLanguageServer']) {
		return;
	}

	// Check that all workspace folders are configured with the same GOPATH.
	if (!allFoldersHaveSameGopath()) {
		vscode.window.showInformationMessage('The Go language server is currently not supported in a multi-root set-up with different GOPATHs.');
		return;
	}

	// Get the path to gopls or any alternative that the user might have set for gopls.
	const goplsBinaryPath = getBinPath('gopls');
	if (path.isAbsolute(goplsBinaryPath)) {
		return goplsBinaryPath;
	}

	// Get the path to go-langserver or any alternative that the user might have set for go-langserver.
	const golangserverBinaryPath = getBinPath('go-langserver');
	if (path.isAbsolute(golangserverBinaryPath)) {
		return golangserverBinaryPath;
	}

	// If no language server path has been found, notify the user.
	let languageServerOfChoice = 'gopls';
	if (goConfig['alternateTools']) {
		const goplsAlternate = goConfig['alternateTools']['gopls'];
		const golangserverAlternate = goConfig['alternateTools']['go-langserver'];
		if (typeof goplsAlternate === 'string') {
			languageServerOfChoice = getToolFromToolPath(goplsAlternate);
		} else if (typeof golangserverAlternate === 'string') {
			languageServerOfChoice = getToolFromToolPath(golangserverAlternate);
		}
	}
	// Only gopls and go-langserver are supported.
	if (languageServerOfChoice !== 'gopls' && languageServerOfChoice !== 'go-langserver') {
		vscode.window.showErrorMessage(`Cannot find the language server ${languageServerOfChoice}. Please install it and reload this VS Code window`);
		return;
	}
	// Otherwise, prompt the user to install the language server.
	promptForMissingTool(languageServerOfChoice);
	vscode.window.showInformationMessage('Reload VS Code window after installing the Go language server.');

}

function allFoldersHaveSameGopath(): boolean {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length <= 1) {
		return true;
	}
	const tempGopath = getCurrentGoPath(vscode.workspace.workspaceFolders[0].uri);
	return vscode.workspace.workspaceFolders.find(x => tempGopath !== getCurrentGoPath(x.uri)) ? false : true;
}

// registerUsualProviders registers the language feature providers if the language server is not enabled.
function registerUsualProviders(ctx: vscode.ExtensionContext) {
	const provider = new GoCompletionItemProvider(ctx.globalState);
	ctx.subscriptions.push(provider);
	ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(GO_MODE, provider, '.', '\"'));
	ctx.subscriptions.push(vscode.languages.registerHoverProvider(GO_MODE, new GoHoverProvider()));
	ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(GO_MODE, new GoDefinitionProvider()));
	ctx.subscriptions.push(vscode.languages.registerReferenceProvider(GO_MODE, new GoReferenceProvider()));
	ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(GO_MODE, new GoDocumentSymbolProvider()));
	ctx.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(new GoWorkspaceSymbolProvider()));
	ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(GO_MODE, new GoSignatureHelpProvider(), '(', ','));
	ctx.subscriptions.push(vscode.languages.registerImplementationProvider(GO_MODE, new GoImplementationProvider()));
	ctx.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(GO_MODE, new GoDocumentFormattingEditProvider()));
	ctx.subscriptions.push(vscode.languages.registerTypeDefinitionProvider(GO_MODE, new GoTypeDefinitionProvider()));
	ctx.subscriptions.push(vscode.languages.registerRenameProvider(GO_MODE, new GoRenameProvider()));
	vscode.workspace.onDidChangeTextDocument(parseLiveFile, null, ctx.subscriptions);
}

async function shouldUpdateLanguageServer(tool: Tool, path: string): Promise<boolean> {
	// Only support updating gopls for now.
	if (tool.name !== 'gopls') {
		return false;
	}
	// First, run the "gopls version" command and parse its results.
	// If "gopls" is so old that it doesn't have the "gopls version" command,
	// or its version doesn't match our expectations, prompt the user to download.
	const usersVersion = await goplsVersion(path);
	if (!usersVersion) {
		return true;
	}
	// We might have a developer version. Don't make the user update.
	if (usersVersion === '(devel)') {
		return false;
	}
	// If the user has a version of gopls that we understand,
	// ask the proxy for the latest version, and if the user's version is older,
	// prompt them to update.
	const listURL = `https://proxy.golang.org/${tool.importPath}/@v/list`;
	const data = await WebRequest.json<string>(listURL);

	// Coerce the versions into SemVers so that they can be sorted correctly.
	const versions = [];
	for (const version of data.trim().split('\n')) {
		versions.push(semver.coerce(version));
	}
	if (versions.length === 0) {
		return false;
	}
	versions.sort(semver.rcompare);
	return semver.lt(usersVersion, versions[0]);
}

async function goplsVersion(goplsPath: string): Promise<string> {
	const env = getToolsEnvVars();
	const util = require('util');
	const execFile = util.promisify(cp.execFile);
	let output: any;
	try {
		const { stdout } = await execFile(goplsPath, ['version'], { env });
		output = stdout;
	} catch (e) {
		// The "gopls version" command is not supported, or something else went wrong.
		// TODO: Should we propagate this error?
		return null;
	}

	const lines = <string>output.trim().split('\n');
	switch (lines.length) {
		case 0:
			// No results, should update.
			// Worth doing anything here?
			return null;
		case 1:
			// Built in $GOPATH mode. Should update.
			// TODO: Should we check the Go version here?
			// Do we even allow users to enable gopls if their Go version is too low?
			return null;
		case 2:
			// We might actually have a parseable version.
			break;
		default:
			return null;
	}

	// The second line should be the sum line.
	// It should look something like this:
	//
	//    golang.org/x/tools/gopls@v0.1.3 h1:CB5ECiPysqZrwxcyRjN+exyZpY0gODTZvNiqQi3lpeo=
	//
	// TODO: We should use a regex to match this, but for now, we split on the @ symbol.
	// The reasoning for this is that gopls still has a golang.org/x/tools/cmd/gopls binary,
	// so users may have a developer version that looks like "golang.org/x/tools@(devel)".
	const moduleVersion = lines[1].trim().split(' ')[0];

	// Get the relevant portion, that is:
	//
	//    golang.org/x/tools/gopls@v0.1.3
	//
	const split = moduleVersion.trim().split('@');
	if (split.length < 2) {
		return null;
	}
	// The version comes after the @ symbol:
	//
	//    v0.1.3
	//
	return split[1];

}

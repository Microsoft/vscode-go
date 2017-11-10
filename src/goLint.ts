import path = require('path');
import vscode = require('vscode');
import { getToolsEnvVars, resolvePath, runTool, ICheckResult, handleDiagnosticErrors, getWorkspaceFolderPath } from './util';
import { outputChannel } from './goStatus';

/**
 * Runs linter in the current package or workspace.
 */
export function lintCode(lintWorkspace?: boolean) {
	let editor = vscode.window.activeTextEditor;
	if (!editor && !lintWorkspace) {
		vscode.window.showInformationMessage('No editor is active, cannot find current package to lint');
		return;
	}
	if (editor.document.languageId !== 'go' && !lintWorkspace) {
		vscode.window.showInformationMessage('File in the active editor is not a Go file, cannot find current package to lint');
		return;
	}

	let documentUri = editor ? editor.document.uri : null;
	let goConfig = vscode.workspace.getConfiguration('go', documentUri);
	outputChannel.clear();
	outputChannel.show();
	outputChannel.appendLine('Litning in progress...');
	goLint(documentUri, goConfig, lintWorkspace)
		.then(warnings => handleDiagnosticErrors(editor ? editor.document : null, warnings, vscode.DiagnosticSeverity.Warning))
		.catch(err => {
			vscode.window.showInformationMessage('Error: ' + err);
		});
}

/**
 * Runs linter and presents the output in the 'Go' channel and in the diagnostic collections.
 *
 * @param fileUri Document uri.
 * @param goConfig Configuration for the Go extension.
 * @param lintWorkspace If true runs linter in all workspace.
 */
export function goLint(fileUri: vscode.Uri, goConfig: vscode.WorkspaceConfiguration, lintWorkspace?: boolean): Promise<ICheckResult[]> {
	let lintTool = goConfig['lintTool'] || 'golint';
	let lintFlags: string[] = goConfig['lintFlags'] || [];
	let lintEnv = Object.assign({}, getToolsEnvVars());
	let args = [];
	let configFlag = '--config=';
	let currentWorkspace = getWorkspaceFolderPath(fileUri);
	lintFlags.forEach(flag => {
		// --json is not a valid flag for golint and in gometalinter, it is used to print output in json which we dont want
		if (flag === '--json') {
			return;
		}
		if (flag.startsWith(configFlag)) {
			let configFilePath = flag.substr(configFlag.length);
			configFilePath = resolvePath(configFilePath);
			args.push(`${configFlag}${configFilePath}`);
			return;
		}
		args.push(flag);
	});
	if (lintTool === 'gometalinter') {
		if (args.indexOf('--aggregate') === -1) {
			args.push('--aggregate');
		}
		if (goConfig['toolsGopath']) {
			// gometalinter will expect its linters to be in the GOPATH
			// So add the toolsGopath to GOPATH
			lintEnv['GOPATH'] += path.delimiter + goConfig['toolsGopath'];
		}
	}

	if (lintWorkspace && currentWorkspace) {
		args.push('./...');
	}

	if (running) {
		tokenSource.cancel();
	}

	running = true;
	const lintPromise = runTool(
		args,
		(lintWorkspace && currentWorkspace) ? currentWorkspace : path.dirname(fileUri.fsPath),
		'warning',
		false,
		lintTool,
		lintEnv,
		false,
		tokenSource.token
	).then((result) => {
		running = false;
		return result;
	});

	return lintPromise;
}

let tokenSource = new vscode.CancellationTokenSource();
let running = false;
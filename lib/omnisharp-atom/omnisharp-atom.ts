require('./configure-rx');
import _ = require('lodash');
import {Observable, BehaviorSubject, Subject, CompositeDisposable} from "rx";
import path = require('path');
import fs = require('fs');
import a = require("atom");
var Emitter = (<any>a).Emitter

// TODO: Remove these at some point to stream line startup.
import Omni = require('../omni-sharp-server/omni');
import dependencyChecker = require('./dependency-checker');
import {world} from './world';

class OmniSharpAtom {
    private features: OmniSharp.IFeature[] = [];
    private emitter: EventKit.Emitter;
    private disposable: Rx.CompositeDisposable;
    private autoCompleteProvider;
    private generator: { run(generator: string, path?: string, options?: any): void; start(prefix: string, path?: string, options?: any): void; };
    private menu: EventKit.Disposable;

    public activate(state) {
        this.disposable = new CompositeDisposable;

        if (dependencyChecker.findAllDeps(this.getPackageDir())) {
            this.emitter = new Emitter;

            this.configureKeybindings();

            this.disposable.add(atom.commands.add('atom-workspace', 'omnisharp-atom:toggle', () => this.toggle()));
            this.disposable.add(atom.commands.add('atom-workspace', 'omnisharp-atom:new-application', () => this.generator.run("aspnet:app", undefined, {promptOnZeroDirectories: true})));
            this.disposable.add(atom.commands.add('atom-workspace', 'omnisharp-atom:new-class', () => this.generator.run("aspnet:Class", undefined, { promptOnZeroDirectories: true })));
            this.disposable.add(this.emitter);

            this.loadAtomFeatures(state).toPromise()
                .then(() => this.loadFeatures(state).toPromise())
                .then(() => {
                    Omni.activate();

                    world.activate();
                    _.each(this.features, f => {
                        f.activate();
                        this.disposable.add(f);
                    });

                    this.disposable.add(atom.workspace.observeTextEditors((editor: Atom.TextEditor) => {
                        this.detectAutoToggleGrammar(editor);
                    }));

                    _.each(this.features, f => {
                        if (_.isFunction(f['attach'])) {
                            f['attach']()
                        }
                    });
                });
        } else {
            _.map(dependencyChecker.errors() || [], missingDependency => console.error(missingDependency))
        }
    }

    private _packageDir: string;
    public getPackageDir() {
        if (!this._packageDir) {
            this._packageDir = _.find(atom.packages.getPackageDirPaths(), function(packagePath) {
                return fs.existsSync(packagePath + "/omnisharp-atom");
            });
        }
        return this._packageDir;
    }

    public loadFeatures(state) {
        var packageDir = this.getPackageDir();
        var featureDir = packageDir + "/omnisharp-atom/lib/omnisharp-atom/features";

        var features = Observable.fromNodeCallback(fs.readdir)(featureDir)
            .flatMap(files => Observable.from(files))
            .where(file => /\.js$/.test(file))
            .flatMap(file => Observable.fromNodeCallback(fs.stat)(featureDir + "/" + file).map(stat => ({ file, stat })))
            .where(z => !z.stat.isDirectory())
            .map(z => z.file)
            .map(feature => {
                var path = "./features/" + feature;
                return <OmniSharp.IFeature[]>_.values(require(path))
            });

        var result = features.toArray()
            .map(features => _.flatten<OmniSharp.IFeature>(features));
        result.subscribe(features => {
            this.features = this.features.concat(features);
        });

        return result;
    }

    public loadAtomFeatures(state) {
        var packageDir = this.getPackageDir();
        var atomFeatureDir = packageDir + "/omnisharp-atom/lib/omnisharp-atom/atom";

        var atomFeatures = Observable.fromNodeCallback(fs.readdir)(atomFeatureDir)
            .flatMap(files => Observable.from(files))
            .where(file => /\.js$/.test(file))
            .flatMap(file => Observable.fromNodeCallback(fs.stat)(atomFeatureDir + "/" + file).map(stat => ({ file, stat })))
            .where(z => !z.stat.isDirectory())
            .map(z => z.file)
            .map(feature => {
                var path = "./atom/" + feature;
                return <OmniSharp.IFeature[]>_.values(require(path))
            });

        var result = atomFeatures.toArray()
            .map(features => _.flatten<OmniSharp.IFeature>(features));
        result.subscribe(features => {
            this.features = this.features.concat(features);
        });

        return result;
    }

    private detectAutoToggleGrammar(editor: Atom.TextEditor) {
        var grammar = editor.getGrammar();
        this.detectGrammar(editor, grammar);
        this.disposable.add(editor.onDidChangeGrammar((grammar: FirstMate.Grammar) => this.detectGrammar(editor, grammar)));
    }

    private detectGrammar(editor: Atom.TextEditor, grammar: FirstMate.Grammar) {
        if (!atom.config.get('omnisharp-atom.autoStartOnCompatibleFile')) {
            return; //short out, if setting to not auto start is enabled
        }

        if (Omni.isOn && !this.menu) {
            this.toggleMenu();
        }

        if (grammar.name === 'C#') {
            if (Omni.isOff) {
                this.toggle();
            }
        } else if (grammar.name === "JSON") {
            if (path.basename(editor.getPath()) === "project.json") {
                if (Omni.isOff) {
                    this.toggle();
                }
            }
        } else if (grammar.name === "C# Script File") {
            if (Omni.isOff) {
                this.toggle()
            }
        }
    }

    private toggleMenu() {
        var menuJsonFile = this.getPackageDir() + "/omnisharp-atom/menus/omnisharp-menu.json";
        var menuJson = JSON.parse(fs.readFileSync(menuJsonFile, 'utf8'));
        this.menu = atom.menu.add(menuJson.menu);
        this.disposable.add(this.menu);
    }

    public toggle() {
        var dependencyErrors = dependencyChecker.errors();
        if (dependencyErrors.length === 0) {
            if (Omni.isOff) {
                Omni.connect();
                this.toggleMenu();
            } else if (Omni.isOn) {
                Omni.disconnect();

                if (this.menu) {
                    this.disposable.remove(this.menu);
                    this.menu.dispose();
                    this.menu = null;
                }
            }
        } else {
            _.map(dependencyErrors, missingDependency => alert(missingDependency));
        }
    }

    public deactivate() {
        this.features = null;
        this.autoCompleteProvider && this.autoCompleteProvider.destroy();
        Omni.deactivate();
    }

    public consumeStatusBar(statusBar) {
        var feature = require('./atom/status-bar');
        feature.statusBar.setup(statusBar);
    }

    public consumeYeomanEnvironment(generatorService: { run(generator: string, path: string): void; start(prefix: string, path: string): void; }) {
        this.generator = generatorService;
    }

    public provideAutocomplete() {
        var {CompletionProvider} = require("./features/lib/completion-provider");
        this.autoCompleteProvider = CompletionProvider;
        return this.autoCompleteProvider;
    }

    private configureKeybindings() {
        var omnisharpFileNew = this.getPackageDir() + "/omnisharp-atom/keymaps/omnisharp-file-new.cson";
        this.disposable.add(atom.config.observe("omnisharp-atom.enableAdvancedFileNew", (enabled) => {
            if (enabled) {
                atom.keymaps.loadKeymap(omnisharpFileNew);
            } else {
                atom.keymaps.removeBindingsFromSource(omnisharpFileNew);
            }
        }));

        var disposable: EventKit.Disposable;
        var omnisharpAdvancedFileNew = this.getPackageDir() + "/omnisharp-atom/keymaps/omnisharp-advanced-file-new.cson";
        this.disposable.add(atom.config.observe("omnisharp-atom.useAdvancedFileNew", (enabled) => {
            if (enabled) {
                atom.keymaps.loadKeymap(omnisharpAdvancedFileNew);

                var anymenu = <any>atom.menu;
                _.each(anymenu.template, (template: any) => {
                    var item = <any>_.find(template.submenu, { command: "application:new-file" });
                    if (item) {
                        item.command = 'advanced-new-file:toggle';
                    }
                });
            } else {
                if (disposable) disposable.dispose();
                atom.keymaps.removeBindingsFromSource(omnisharpAdvancedFileNew);

                var anymenu = <any>atom.menu;
                _.each(anymenu.template, (template: any) => {
                    var item = <any>_.find(template.submenu, { command: "advanced-new-file:toggle" });
                    if (item) {
                        item.command = 'application:new-file';
                    }
                });
            }
        }));
    }

    public config = {
        autoStartOnCompatibleFile: {
            title: "Autostart Omnisharp Roslyn",
            description: "Automatically starts Omnisharp Roslyn when a compatible file is opened.",
            type: 'boolean',
            default: true
        },
        developerMode: {
            title: 'Developer Mode',
            description: 'Outputs detailed server calls in console.log',
            type: 'boolean',
            default: false
        },
        showDiagnosticsForAllSolutions: {
            title: 'Show Diagnostics for all Solutions',
            description: 'Advanced: This will show diagnostics for all open solutions.  NOTE: May take a restart or change to each server to take effect when turned on.',
            type: 'boolean',
            default: false
        },
        enableAdvancedFileNew: {
            title: 'Enable `Advanced File New`',
            description: 'Enable `Advanced File New` when doing ctrl-n/cmd-n within a C# editor.',
            type: 'boolean',
            default: true
        },
        useAdvancedFileNew: {
            title: 'Use `Advanced File New` as default',
            description: 'Use `Advanced File New` as your default new command everywhere.',
            type: 'boolean',
            default: false
        },
        useLeftLabelColumnForSuggestions: {
            title: 'Use Left-Label column in Suggestions',
            description: 'Shows return types in a right-aligned column to the left of the completion suggestion text.',
            type: 'boolean',
            default: false
        },
        useIcons: {
            title: 'Use unique icons for kind indicators in Suggestions',
            description: 'Shows kinds with unique icons rather than autocomplete default styles.',
            type: 'boolean',
            default: true
        }
    }
}

var instance = new OmniSharpAtom
export = instance;

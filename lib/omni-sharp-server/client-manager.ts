import _ = require('lodash')
import path = require('path');
import {Observable, AsyncSubject, RefCountDisposable, Disposable, CompositeDisposable, ReplaySubject, Scheduler} from "rx";
import Client = require('./client');
import {ObservationClient, CombinationClient} from './composite-client';
import {findCandidates, DriverState} from "omnisharp-client";

class ClientManager {
    private _disposable = new CompositeDisposable;
    private _clients: { [path: string]: Client } = {};
    private _configurations: ((client: Client) => void)[] = [];
    private _projectClientPaths: { [key: string]: string[] } = {};
    private _clientPaths: string[] = [];
    private _projectPaths: string[] = [];
    private _activated = false;
    private _temporaryClients: { [path: string]: RefCountDisposable } = {};
    private _nextIndex = 0;

    public get activeClients() { return this._activeClients }
    private _activeClients: Client[] = [];

    // this client can be used to observe behavior across all clients.
    private _observationClient = new ObservationClient();
    public get observationClient() { return this._observationClient; }

    // this client can be used to aggregate behavior across all clients
    private _combinationClient = new CombinationClient();
    public get combinationClient() { return this._combinationClient; }

    private _activeClient = new ReplaySubject<Client>(1);
    private _activeClientObserable = this._activeClient.distinctUntilChanged();
    public get activeClient(): Observable<Client> { return this._activeClientObserable; }

    public activate(activeEditor: Observable<Atom.TextEditor>) {
        this._activated = true;

        // monitor atom project paths
        this.updatePaths(atom.project.getPaths());
        this._disposable.add(atom.project.onDidChangePaths((paths) => this.updatePaths(paths)));

        // We use the active editor on omnisharpAtom to
        // create another observable that chnages when we get a new client.
        this._disposable.add(activeEditor
            .where(z => !!z)
            .flatMap(z => this.getClientForEditor(z))
            .subscribe(x => this._activeClient.onNext(x)));
    }

    public connect() {
        _.each(this._clients, x => x.connect());
    }

    public disconnect() {
        _.each(this._clients, x => x.disconnect());
    }

    public deactivate() {

    }

    public get connected() {
        return _.any(this._clients, z => z.currentState === DriverState.Connected);
    }

    private updatePaths(paths: string[]) {
        var newPaths = _.difference(paths, this._projectPaths);
        var removePaths = _.intersection(newPaths, _.keys(this._clients));
        var addedPaths = _.difference(newPaths, _.keys(this._clients));

        _.each(removePaths, project => {
            this.removeClient(project);
        });

        _.each(addedPaths, project => {
            var localPaths = this._projectClientPaths[project] = [];
            findCandidates(project, console).toPromise().then(candidates => {
                for (var candidate of candidates) {
                    this.addClient(candidate, localPaths);
                }
            });
        });

        this._projectPaths = paths;
    }

    private addClient(candidate: string, localPaths: string[], delay = 1200, temporary?: boolean) {
        if (this._clients[candidate])
            return;

        localPaths.push(candidate);
        this._clientPaths.push(candidate);

        var client = new Client({
            projectPath: candidate,
            index: ++this._nextIndex
        });

        _.each(this._configurations, config => config(client));
        this._clients[candidate] = client;

        if (temporary) {
            var tempD = Disposable.create(() => { });
            tempD.dispose();
            this._temporaryClients[candidate] = new RefCountDisposable(tempD);
        }

        // Auto start, with a little delay
        if (atom.config.get('omnisharp-atom.autoStartOnCompatibleFile')) {
            _.delay(() => client.connect(), delay);
        }

        this._activeClients.push(client);
        if (this._activeClients.length === 1)
            this._activeClient.onNext(client);
        // keep track of the active clients
        this._observationClient.add(client);
        this._combinationClient.add(client);

        client.state
            .where(z => z === DriverState.Error)
            .delay(100)
            .subscribe(state => this.evictClient(client));

        return client;
    }

    private removeClient(candidate: string) {
        var client = this._clients[candidate];

        var refCountDisposable = this._temporaryClients[candidate]
        if (refCountDisposable) {
            refCountDisposable.dispose();
            if (!refCountDisposable.isDisposed) {
                return;
            }

            this.evictClient(client);
        }

        // keep track of the removed clients
        client.disconnect();
    }

    public evictClient(client: Client) {
        if (client.currentState === DriverState.Connected || client.currentState === DriverState.Connecting) {
            client.disconnect();
        }

        delete this._temporaryClients[client.path];
        delete this._clients[client.path];
        _.pull(this._clientPaths, client.path);
        _.pull(this._activeClients, client);
        this._observationClient.remove(client);
        this._combinationClient.remove(client);
    }

    private getClientForActiveEditor() {
        var editor = atom.workspace.getActiveTextEditor();
        var client: Observable<Client>;
        if (editor)
            client = this.getClientForEditor(editor);

        if (client) return client;
        // No active text editor
        return Observable.empty<Client>();
    }

    public getClientForEditor(editor: Atom.TextEditor) {
        var client: Observable<Client>;
        if (!editor)
            // No text editor found
            return Observable.empty<Client>();

        if (!editor.getPath) {
            // Not a text editor
            return Observable.empty<Client>();
        }

        var grammarName = editor.getGrammar().name;
        var valid = false;
        if (grammarName === 'C#' || grammarName === 'C# Script File')
            valid = true;

        var filename = path.basename(editor.getPath());
        if (filename === 'project.json') {
            valid = true;
        }

        if (!valid)
            // No valid text editor
            return Observable.empty<Client>();


        var p = (<any>editor).omniProject;
        // Not sure if we should just add properties onto editors...
        // but it works...
        if (p) {
            if (this._clients[p]) {
                var tempC = this._clients[p];
                // If the client has disconnected, reconnect it
                if (tempC.currentState === DriverState.Disconnected)
                    tempC.connect();

                // Client is in an invalid state
                if (tempC.currentState === DriverState.Error) {
                    return Observable.empty<Client>();
                }

                client = Observable.just(this._clients[p]);

                if (this._temporaryClients[p]) {
                    this.setupDisposableForTemporaryClient(p, editor);
                }

                return client;
            }
        }

        var location = editor.getPath();
        if (!location) {
            // Text editor not saved yet?
            return Observable.empty<Client>();
        }
        
        var [intersect, clientInstance] = this.getClientForUnderlyingPath(location, grammarName);
        p = (<any>editor).omniProject = intersect;

        if (this._temporaryClients[p]) {
            this.setupDisposableForTemporaryClient(p, editor);
        }

        if (clientInstance)
            return Observable.just(clientInstance);

        return this.findClientForUnderlyingPath(location)
            .map(z => {
                var [p, client, temporary] = z;
                (<any>editor).omniProject = p;
                if (temporary) {
                    this.setupDisposableForTemporaryClient(p, editor);
                }
                return client;
            });
    }

    private getClientForUnderlyingPath(location: string, grammar?: string): [string, Client] {
        if (location === undefined) {
            return;
        }

        if (grammar === 'C# Script File' || _.endsWith(location, '.csx')) {
            // CSX are special, and need a client per directory.
            var directory = path.dirname(location);
            var csClient = this._clients[directory];
            if (csClient)
                return [directory, csClient];
        } else {
            var intersect = intersectPath(location, this._clientPaths);
            if (intersect) {
                return [intersect, this._clients[intersect]];
            }
        }

        // Attempt to see if this file is part a clients solution
        for (var client of this._activeClients) {
            var paths = client.model.projects.map(z => path);
            var intersect = intersectPath(location, this._clientPaths);
            if (intersect) {
                return [intersect, this._clients[intersect]];
            }
        }

        return [null, null];
    }

    private findClientForUnderlyingPath(location: string, grammar?: string): Observable<[string, Client, boolean]> {
        var directory = path.dirname(location);
        var project = intersectPath(directory, this._projectPaths);
        var localPaths: string[];
        if (project)
            localPaths = this._projectClientPaths[project] = [];

        var subject = new AsyncSubject<[string, Client, boolean]>();

        var foundCandidates = findCandidates(directory, console)
            .subscribe(candidates => {
                var newCandidates = _.difference(candidates, this._clientPaths);
                for (var candidate of candidates) {
                    this.addClient(candidate, localPaths || [], 0, !project);
                }

                var intersect = intersectPath(location, this._clientPaths) || intersectPath(location, this._projectPaths);
                if (intersect) {
                    subject.onNext([intersect, this._clients[intersect], !project]); // The boolean means this client is temporary.
                } else {
                    subject.onError('Could not find a client for location ' + location);
                }
                subject.onCompleted();
            });

        return subject;
    }

    private setupDisposableForTemporaryClient(path: string, editor: Atom.TextEditor) {
        if (!editor['__setup_temp__'] && this._temporaryClients[path]) {
            var refCountDisposable = this._temporaryClients[path];
            var disposable = refCountDisposable.getDisposable();
            editor['__setup_temp__'] = true
            editor.onDidDestroy(() => {
                disposable.dispose();
                this.removeClient(path);
            });
        }
    }

    public registerConfiguration(callback: (client: Client) => void) {
        this._configurations.push(callback);

        _.each(this._clients, (client) => {
            callback(client);
        });
    }
}

function intersectPath(location: string, paths: string[]): string {
    var segments = location.split(path.sep);
    var mappedLocations = segments.map((loc, index) => {
        return _.take(segments, index + 1).join(path.sep);
    });

    // Look for the closest match first.
    mappedLocations.reverse();

    var intersect = (<any>_<string[]>(mappedLocations)).intersection(paths).first();
    if (intersect) {
        return intersect;
    }
}

var instance = new ClientManager();
export = instance;

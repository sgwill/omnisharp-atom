import {CompositeDisposable} from "rx";
import Omni = require('../../omni-sharp-server/omni')

class Intellisense implements OmniSharp.IFeature {
    private disposable: Rx.CompositeDisposable;

    public activate() {
        this.disposable = new CompositeDisposable();
        this.disposable.add(Omni.addTextEditorCommand('omnisharp-atom:intellisense-dot',
            (event) => {
                this.complete(event, '.');
                setTimeout(() =>
                    atom.commands.dispatch(atom.views.getView(atom.workspace.getActiveTextEditor()), 'autocomplete-plus:activate'), 0);
            }));

        this.disposable.add(Omni.addTextEditorCommand('omnisharp-atom:intellisense-space',
            (event) => this.complete(event, ' ')));

        this.disposable.add(Omni.addTextEditorCommand('omnisharp-atom:intellisense-semicolon',
            (event) => this.complete(event, ';')));

    }

    public dispose() {
        this.disposable.dispose();
    }

    private complete(event: Event, char: string) {
        var editor = atom.workspace.getActiveTextEditor();
        if (editor) {
            var view = atom.views.getView(editor);
            atom.commands.dispatch(atom.views.getView(editor), 'autocomplete-plus:confirm');
            editor.insertText(char);

            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            return false;
        }
    }
}
export var intellisense = new Intellisense

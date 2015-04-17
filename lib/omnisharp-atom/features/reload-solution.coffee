Omni = require '../../omni-sharp-server/omni'

module.exports =
  class ReloadSolution

    activate: =>
      atom.commands.add 'atom-workspace', "omnisharp-atom:reload-solution", ->
        Omni.reloadSolution()

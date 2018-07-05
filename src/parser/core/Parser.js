import Raven from 'raven-js'
import React from 'react'
import toposort from 'toposort'

import ErrorMessage from 'components/ui/ErrorMessage'
import {DependencyCascadeError} from 'errors'

class Parser {
	// -----
	// Properties
	// -----

	report = null
	fight = null
	player = null
	_timestamp = 0

	modules = {}
	_constructors = {}

	moduleOrder = []
	_triggerModules = []
	_moduleErrors = {}

	get currentTimestamp() {
		// TODO: this.finished?
		return Math.min(this.fight.end_time, this._timestamp)
	}

	get fightDuration() {
		// TODO: should i have like... currentDuration and fightDuration?
		//       this seems a bit jank
		return this.currentTimestamp - this.fight.start_time
	}

	// Get the friendlies that took part in the current fight
	get fightFriendlies() {
		return this.report.friendlies.filter(
			friend => friend.fights.some(fight => fight.id === this.fight.id)
		)
	}

	// -----
	// Constructor
	// -----

	constructor(report, fight, player) {
		this.report = report
		this.fight = fight
		this.player = player

		// Set initial timestamp
		this._timestamp = fight.start_time
	}

	// -----
	// Module handling
	// -----

	addModules(modules) {
		// Merge the modules into our constructor object
		Object.assign(this._constructors, modules)
	}

	buildModules() {
		// Build the values we need for the toposort
		const nodes = Object.keys(this._constructors)
		const edges = []
		nodes.forEach(mod => this._constructors[mod].dependencies.forEach(dep => {
			edges.push([mod, dep])
		}))

		// Sort modules to load dependencies first
		// Reverse is required to switch it into depencency order instead of sequence
		// This will naturally throw an error on cyclic deps
		this.moduleOrder = toposort.array(nodes, edges).reverse()

		// Initialise the modules
		this.moduleOrder.forEach(mod => {
			this.modules[mod] = new this._constructors[mod](this)
		})
	}

	// -----
	// Event handling
	// -----

	normalise(events) {
		// Run normalisers
		// This intentionally does not have error handling - modules may be relying on normalisers without even realising it. If something goes wrong, it could totally throw off results.
		this.moduleOrder.forEach(mod => {
			events = this.modules[mod].normalise(events)
		})
		return events
	}

	parseEvents(events) {
		// Create a copy of the module order that we'll use while parsing
		this._triggerModules = this.moduleOrder.slice(0)

		this.fabricateEvent({type: 'init'})

		// Run the analysis pass
		events.forEach(event => {
			this._timestamp = event.timestamp
			this.triggerEvent(event)
		})

		this.fabricateEvent({type: 'complete'})
	}

	fabricateEvent(event, trigger) {
		// TODO: they've got a 'triggered' prop too...?
		this.triggerEvent({
			// Default to the current timestamp
			timestamp: this.currentTimestamp,
			trigger,
			// Rest of the event, mark it as fab'd
			...event,
			__fabricated: true,
		})
	}

	triggerEvent(event) {
		// TODO: Do I need to keep a history?
		this._triggerModules.forEach(mod => {
			try {
				this.modules[mod].triggerEvent(event)
			} catch (error) {
				// Error trying to handle an event, tell sentry
				Raven.captureException(error)

				// Also cascade the error through the dependency tree
				this._setModuleError(mod, error)
			}
		})
	}

	_setModuleError(mod, error) {
		// Set the error for the current module
		this._triggerModules.splice(this._triggerModules.indexOf(mod), 1)
		this._moduleErrors[mod] = error

		// Cascade via dependencies
		Object.keys(this._constructors).forEach(key => {
			const constructor = this._constructors[key]
			if (constructor.dependencies.includes(mod)) {
				this._setModuleError(key, new DependencyCascadeError({dependency: mod}))
			}
		})
	}

	// -----
	// Results handling
	// -----

	generateResults() {
		const displayOrder = this.moduleOrder
		displayOrder.sort((a, b) => this.modules[a].constructor.displayOrder - this.modules[b].constructor.displayOrder)

		const results = []
		displayOrder.forEach(mod => {
			const module = this.modules[mod]

			// If there's an error, override output handling to show it
			if (this._moduleErrors[mod]) {
				const error = this._moduleErrors[mod]
				results.push({
					name: module.name,
					markup: <ErrorMessage error={error} />,
				})
				return
			}

			// Use the ErrorMessage component for errors in the output too (and sentry)
			let output = null
			try {
				output = module.output()
			} catch (error) {
				Raven.captureException(error)
				results.push({
					name: module.name,
					markup: <ErrorMessage error={error} />,
				})
				return
			}

			if (output) {
				results.push({
					name: module.name,
					markup: output,
				})
			}
		})

		return results
	}

	// -----
	// Utilities
	// -----

	byPlayer(event, playerId = this.player.id) {
		return event.sourceID === playerId
	}

	toPlayer(event, playerId = this.player.id) {
		return event.targetID === playerId
	}

	byPlayerPet(event, playerId = this.player.id) {
		const pet = this.report.friendlyPets.find(pet => pet.id === event.sourceID)
		return pet && pet.petOwner === playerId
	}

	toPlayerPet(event, playerId = this.player.id) {
		const pet = this.report.friendlyPets.find(pet => pet.id === event.targetID)
		return pet && pet.petOwner === playerId
	}

	formatTimestamp(timestamp, secondPrecision) {
		return this.formatDuration(timestamp - this.fight.start_time, secondPrecision)
	}

	formatDuration(duration, secondPrecision = null) {
		duration /= 1000
		const seconds = duration % 60
		if (duration < 60) {
			const precision = secondPrecision !== null? secondPrecision : seconds < 10? 2 : 0
			return seconds.toFixed(precision) + 's'
		}
		const precision = secondPrecision !== null ? secondPrecision : 0
		return `${Math.floor(duration / 60)}:${seconds < 10? '0' : ''}${seconds.toFixed(precision)}`

	}
}

export default Parser

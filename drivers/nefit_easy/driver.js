const Homey           = require('homey');
const NefitEasyClient = require('nefit-easy-commands');
const Device          = require('./device');
const Capabilities    = require('./capabilities');

module.exports = class NefitEasyDriver extends Homey.Driver {

  onInit() {
    // Register flow cards.
    this.registerFlowCards();
  }

  registerFlowCards() {
    this._triggers = {
      [ Capabilities.OPERATING_MODE ] : this.homey.flow.getDeviceTriggerCard('operating_mode_changed'),
      [ Capabilities.PRESSURE ]       : this.homey.flow.getDeviceTriggerCard('system_pressure_changed'),
      [ Capabilities.ALARM_PRESSURE ] : this.homey.flow.getDeviceTriggerCard('alarm_pressure_active'),
    }

    this._conditions = {
      operating_mode_matches : this.homey.flow.getConditionCard('operating_mode_matches').registerRunListener(async (args, state) => {
        return args.mode === state.value;
      }),
      shower_timer_matches : this.homey.flow.getConditionCard('shower_timer_matches').registerRunListener(async (args, state) => {
        return args.timer === state.value;
      })
    }
  }

  onPair(session) {
    session.setHandler('validate_device', async data => this.validateDevice(data));
  }

  async validateDevice(data) {
    this.log('validating new device', data);
    // Check and see if we can connect to the backend with the supplied credentials.
    let client;
    try {
      client = await Device.prototype.getClient.call(this, data);
    } catch(e) {
      this.log('unable to instantiate client:', e.message);
      throw e;
    }

    // Check if device was already registered.
    let alreadyRegistered = false;
    try {
      let device = this.getDevice(data);
      alreadyRegistered = true;
      this.log('device is already registered');
    } catch(e) {
      // okay, actually
    }

    if (alreadyRegistered) {
      client.end();
      throw Error('duplicate');
    }

    // Retrieve status to see if we can successfully load data from backend.
    try {
      await client.status();
    } catch(e) {
      // This happens when the Nefit Easy client wasn't able to decode the
      // response from the Nefit backend, which means that the password wasn't
      // correct.
      if (e instanceof SyntaxError) {
        this.log('invalid credentials');
        throw Error('credentials');
      }
      throw e;
    } finally {
      client.end();
    }

    // Everything checks out.
    return {
      name : 'Nefit Easy',
      data,
      store: {
        paired_with_app_version: this.homey.app.manifest.version
      }
    };
  }
}

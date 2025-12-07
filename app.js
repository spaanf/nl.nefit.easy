const Homey    = require('homey');
const camelize = s => s.replace(/(_[a-z])/g, m => m[1].toUpperCase());

module.exports = class NefitEasyApp extends Homey.App {
  onInit(manifest) {
    this.homey.log(`${ this.manifest.id } is running...(debug mode ${ Homey.env.DEBUG ? 'on' : 'off' })`);
    if (Homey.env.DEBUG) {
      require('inspector').open(9229, '0.0.0.0');
    }

    // Register actions.
    this.registerAction('set_clock_program');
    this.registerAction('set_fireplace_mode');
    this.registerAction('set_holiday_mode');
    this.registerAction('set_shower_timer');
    this.registerAction('set_shower_time');
  }

  registerAction(name) {
    const method = camelize(name) + 'Action';
    this.homey.flow.getActionCard(name).registerRunListener(this[method].bind(this));
  }

  async setClockProgramAction(args, state) {
    return args.device.onSetClockProgramme({ clock_programme : args.value === 'on' });
  }

  async setFireplaceModeAction(args, state) {
    return args.device.onSetFireplaceMode({ fireplace_mode : args.value === 'on' });
  }

  async setHolidayModeAction(args, state) {
    return args.device.onSetHolidayMode({ holiday_mode : args.value === 'on' });
  }

  async setShowerTimerAction(args, state) {
    return args.device.onSetShowerTimer({ shower_timer : args.value === 'on' });
  }

  async setShowerTimeAction(args, state) {
    this.log('app.js args = ',args);
    return args.device.onSetShowerTime({ shower_time : args.time })
  }
}

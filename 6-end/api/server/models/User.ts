import * as _ from 'lodash';
import * as mongoose from 'mongoose';

import sendEmail from '../aws-ses';
import { addToMailchimp } from '../mailchimp';
import { generateSlug } from '../utils/slugify';
import getEmailTemplate from './EmailTemplate';

mongoose.set('useFindAndModify', false);

const mongoSchema = new mongoose.Schema({
  slug: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  publicAddress: {
    type: String,
    required: false,
    unique: true,
  },
  nonce: {
    type: Number,
    required: false,
    unique: true,
  },
  displayName: String,
  avatarUrl: String,
  googleId: {
    type: String,
    unique: true,
    sparse: true,
  },
  googleToken: {
    accessToken: String,
    refreshToken: String,
  },
  isSignedupViaGoogle: {
    type: Boolean,
    required: true,
    default: false,
  },
});

// interface UserDocument extends mongoose.Document {
export interface UserDocument extends mongoose.Document {
  slug: string;
  createdAt: Date;
  email: string;
  publicAddress: string;
  nonce: string;
  displayName: string;
  avatarUrl: string;
  googleId: string;
  googleToken: { accessToken: string; refreshToken: string };
  isSignedupViaGoogle: boolean;
}

interface UserModel extends mongoose.Model<UserDocument> {
  getUserBySlug({ slug }: { slug: string }): Promise<UserDocument>;

  updateProfile({
    userId,
    name,
    publicAddress,
    avatarUrl,
  }: {
    userId: string;
    name: string;
    publicAddress: string;
    avatarUrl: string;
  }): Promise<UserDocument[]>;

  publicFields(): string[];

  signInOrSignUpViaGoogle({
    googleId,
    email,
    publicAddress,
    nonce,
    displayName,
    avatarUrl,
    googleToken,
  }: {
    googleId: string;
    email: string;
    publicAddress: string;
    nonce: number;
    displayName: string;
    avatarUrl: string;
    googleToken: { accessToken?: string; refreshToken?: string };
  }): Promise<UserDocument>;

  signInOrSignUpByPasswordless({
    uid,
    email,
  }: {
    uid: string;
    email: string;
  }): Promise<UserDocument>;
}

class UserClass extends mongoose.Model {
  public static async getUserBySlug({ slug }) {
    console.log('Static method: getUserBySlug');

    return this.findOne({ slug }, 'email publicAddress displayName avatarUrl').setOptions({
      lean: true,
    });
  }

  public static async updateProfile({ userId, name, publicAddress, avatarUrl }) {
    console.log('Static method: updateProfile');

    const user = await this.findById(userId, 'slug displayName publicAddress');

    const modifier = {
      displayName: user.displayName,
      publicAddress: user.publicAddress,
      avatarUrl,
      slug: user.slug,
    };

    // console.log(user.slug);

    modifier.publicAddress = publicAddress;

    if (publicAddress !== user.publicAddress) {
      modifier.publicAddress = publicAddress;

      modifier.slug = await generateSlug(this, name, publicAddress);
    }
    if (name !== user.displayName) {
      modifier.displayName = name;
      modifier.slug = await generateSlug(this, name);
    }
    modifier.slug = await generateSlug(this, name, publicAddress);

    // console.log(JSON.stringify(modifier));

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('displayName publicAddress, avatarUrl slug')
      .setOptions({ lean: true });
  }

  public static publicFields(): string[] {
    return [
      '_id',
      'id',
      'displayName',
      'email',
      'publicAddress',
      'avatarUrl',
      'slug',
      'isSignedupViaGoogle',
    ];
  }

  public static async signInOrSignUpViaGoogle({
    googleId,
    email,
    publicAddress,
    nonce,
    displayName,
    avatarUrl,
    googleToken,
  }) {
    const user = await this.findOne({ email })
      .select([...this.publicFields(), 'googleId'].join(' '))
      .setOptions({ lean: true });

    if (user) {
      if (_.isEmpty(googleToken) && user.googleId) {
        return user;
      }

      const modifier = { googleId };
      if (googleToken.accessToken) {
        modifier['googleToken.accessToken'] = googleToken.accessToken;
      }

      if (googleToken.refreshToken) {
        modifier['googleToken.refreshToken'] = googleToken.refreshToken;
      }

      await this.updateOne({ email }, { $set: modifier });

      return user;
    }

    const slug = await generateSlug(this, displayName, publicAddress);

    const newUser = await this.create({
      createdAt: new Date(),
      googleId,
      email,
      publicAddress,
      nonce,
      googleToken,
      displayName,
      avatarUrl,
      slug,
      isSignedupViaGoogle: true,
    });

    const emailTemplate = await getEmailTemplate('welcome', { userName: displayName });

    if (!emailTemplate) {
      throw new Error('Welcome email template not found');
    }

    try {
      await sendEmail({
        from: `Kelly from saas-app.async-await.com <${process.env.EMAIL_SUPPORT_FROM_ADDRESS}>`,
        to: [email],
        subject: emailTemplate.subject,
        body: emailTemplate.message,
      });
    } catch (err) {
      console.error('Email sending error:', err);
    }

    try {
      await addToMailchimp({ email, listName: 'signups' });
    } catch (error) {
      console.error('Mailchimp error:', error);
    }

    return _.pick(newUser, this.publicFields());
  }

  public static async signInOrSignUpByPasswordless({ uid, email }) {
    const user = await this.findOne({ email })
      .select(this.publicFields().join(' '))
      .setOptions({ lean: true });

    if (user) {
      throw Error('User already exists');
    }

    const slug = await generateSlug(this, email);

    const newUser = await this.create({
      _id: uid,
      createdAt: new Date(),
      email,
      slug,
    });

    const emailTemplate = await getEmailTemplate('welcome', { userName: email });

    if (!emailTemplate) {
      throw new Error('Email template "welcome" not found in database.');
    }

    try {
      await sendEmail({
        from: `Kelly from saas-app.async-await.com <${process.env.EMAIL_SUPPORT_FROM_ADDRESS}>`,
        to: [email],
        subject: emailTemplate.subject,
        body: emailTemplate.message,
      });
    } catch (err) {
      console.error('Email sending error:', err);
    }

    try {
      await addToMailchimp({ email, listName: 'signups' });
    } catch (error) {
      console.error('Mailchimp error:', error);
    }

    return _.pick(newUser, this.publicFields());
  }
}

mongoSchema.loadClass(UserClass);

const User = mongoose.model<UserDocument, UserModel>('User', mongoSchema);

export default User;
